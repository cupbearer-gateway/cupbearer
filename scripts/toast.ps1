# Toast notification for Cupbearer failover events.
#
# Reads title/message from environment (CB_TOAST_TITLE / CB_TOAST_MESSAGE) so
# the caller never has to fight Windows argument quoting. Deliberately
# self-contained: no BurntToast or other module, no internet. It does three
# things:
#
#   1. Ensures a Start Menu shortcut carrying the AppUserModelID exists. Windows
#      toast notifications need an app identity, and on Win10/11 that identity is
#      a Start Menu shortcut with the AppUserModelID property set — the toast is
#      attributed to that shortcut's icon and name.
#   2. Shows the toast via the WinRT ToastNotificationManager.
#   3. Falls back to a classic popup if toasts are unavailable (e.g. Server Core).
#
# Exits 0 on success. Never throws to the caller.

param()
$ErrorActionPreference = "SilentlyContinue"

$title = [string]$env:CB_TOAST_TITLE
$message = [string]$env:CB_TOAST_MESSAGE
if (-not $title -and -not $message) { exit 0 }

$root = Split-Path -Parent $PSScriptRoot

# Prefer dist (what the shortcuts point at), fall back to ui/public (the
# canonical copy). dist is rebuilt with emptyOutDir, so it is briefly missing
# these between a logo change and the next UI build; ui/public never is.
function Resolve-Asset([string]$name) {
  foreach ($dir in @("dist", "ui\public")) {
    $p = Join-Path $root (Join-Path $dir $name)
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

$ico = Resolve-Asset "cupbearer.ico"
$toastPng = Resolve-Asset "cupbearer-toast.png"
$AUMID = "Cupbearer.Dashboard"
$startMenu = [Environment]::GetFolderPath("Programs")
$lnk = Join-Path $startMenu "Cupbearer Notifications.lnk"

# ---------------------------------------------------------------- 1. identity
# Re-stamp the icon on the shortcut every run too: Windows caches shortcut icons
# lazily and a freshly created .lnk can show blank in toasts until it is touched.
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
if ($ico) { $sc.IconLocation = "$ico,0" }
$sc.Description = "Cupbearer notifications"
$sc.Save()
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws)

# Stamp the AppUserModelID onto the shortcut. Needs a property store, which
# WScript.Shell does not expose, so this is a small inline P/Invoke.
$src = @"
using System;
using System.Runtime.InteropServices;

public static class CupbearerAumid {
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint c);
    int GetAt(uint i, out PropertyKey k);
    int GetValue(ref PropertyKey k, out PropVariant v);
    int SetValue(ref PropertyKey k, ref PropVariant v);
    int Commit();
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)]
  struct PropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr val; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr pbc, uint flags, ref Guid riid, out IPropertyStore store);

  static readonly Guid FMTID_AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  static readonly Guid IID_IPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");

  public static void Set(string lnkPath, string appId) {
    var riid = IID_IPropertyStore; // locals can be passed by ref; static readonly cannot
    IPropertyStore store;
    int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref riid, out store);
    if (hr != 0) throw new COMException("SHGetPropertyStore failed: 0x" + hr.ToString("X8"));
    var key = new PropertyKey { fmtid = FMTID_AppUserModel, pid = 5 };
    var pv = new PropVariant { vt = 31, val = Marshal.StringToCoTaskMemUni(appId) };
    try { store.SetValue(ref key, ref pv); store.Commit(); }
    finally {
      Marshal.FreeCoTaskMem(pv.val);
      Marshal.ReleaseComObject(store);
    }
  }
}
"@
try {
  Add-Type -TypeDefinition $src
  [CupbearerAumid]::Set($lnk, $AUMID)
} catch {
  # Identity failed — toasts would be rejected anyway. Popup fallback below.
}

# ------------------------------------------------------------------ 2. toast
function esc([string]$s) { return [System.Security.SecurityElement]::Escape($s) }

# The toast's small app logo comes from the Win32 shortcut icon, which Windows
# renders lazily and can show blank. appLogoOverride sidesteps that entirely:
# it is an explicit image carried inside the toast payload, so the icon always
# shows. (Used by toast providers in the Action Center too.)
$appLogo = ""
if ($toastPng) {
  $appLogo = "`n      <image placement=`"appLogoOverride`" src=`"$(([System.Uri]$toastPng).AbsoluteUri)`"/>"
}
$toastXml = @"
<?xml version="1.0" encoding="utf-8"?>
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>$(esc($title))</text>
      <text>$(esc($message))</text>$appLogo
    </binding>
  </visual>
</toast>
"@

$shown = $false
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
  $xml.LoadXml($toastXml)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AUMID)
  $notifier.Show($toast)
  $shown = $true
} catch {}

# ---------------------------------------------------------------- 3. fallback
if (-not $shown) {
  try {
    $ws = New-Object -ComObject WScript.Shell
    [void]$ws.Popup("$title`n`n$message", 8, "Cupbearer", 0x40)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws)
  } catch {}
}

if ($env:CB_TOAST_DEBUG -eq "1") {
  Write-Output ("mode=" + $(if ($shown) { "toast" } else { "popup" }))
}

exit 0
