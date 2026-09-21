# Rebuild ui/public/cupbearer.ico from the canonical logo (ui/public/logo.png).
#
# The previous cupbearer.ico carried malformed PNG-compressed layers — Windows
# itself could not decode it (System.Drawing.Icon throws "parameter is
# incorrect"), so the toast HEADER icon fell back to the generic white page
# while the toast body (a plain PNG) looked fine. This writes the one format
# every Windows icon extractor has handled since forever: 32bpp BI_BITMAP DIB
# entries (alpha channel + all-zero AND mask), no PNG layers at all.
#
# Single source of truth: ui/public/logo.png IS the brand. Re-run after any
# logo change. (scripts/make-icon.ps1 predates the seal artwork — do not run
# it; it would overwrite these assets with the pre-rebrand mark.)

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $root "ui\public\logo.png"
$icoPath = Join-Path $root "ui\public\cupbearer.ico"

$sizes = @(256, 64, 48, 32, 24, 16)
$fill = 0.88         # seal fills this share of the tile
$radiusFrac = 0.20   # corner radius as a share of the tile

# --- crop the seal out of the logo, render it on a rounded tile at any size ---
function New-SealBitmap([int]$size) {
  $logo = [System.Drawing.Bitmap]::FromFile($srcPath)
  $minx = $logo.Width; $miny = $logo.Height; $maxx = 0; $maxy = 0
  for ($y = 0; $y -lt $logo.Height; $y += 4) {
    for ($x = 0; $x -lt $logo.Width; $x += 4) {
      $c = $logo.GetPixel($x, $y)
      if ($c.A -gt 100 -and $c.R -gt 120 -and $c.G -gt 90 -and ($c.R - $c.B) -gt 40) {
        if ($x -lt $minx) { $minx = $x }
        if ($x -gt $maxx) { $maxx = $x }
        if ($y -lt $miny) { $miny = $y }
        if ($y -gt $maxy) { $maxy = $y }
      }
    }
  }
  if ($maxx -le $minx -or $maxy -le $miny) { $logo.Dispose(); throw "no seal artwork found in $srcPath" }

  $cx = ($minx + $maxx) / 2.0
  $cy = ($miny + $maxy) / 2.0
  $side = [Math]::Max($maxx - $minx, $maxy - $miny) / $fill
  $srcRect = New-Object System.Drawing.RectangleF (($cx - $side / 2), ($cy - $side / 2), $side, $side)

  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $r = $size * $radiusFrac
  $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $tile.AddArc(0, 0, $d, $d, 180, 90)
  $tile.AddArc($size - $d, 0, $d, $d, 270, 90)
  $tile.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $tile.AddArc(0, $size - $d, $d, $d, 90, 90)
  $tile.CloseFigure()
  $g.SetClip($tile)
  $destRect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
  $g.DrawImage($logo, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $logo.Dispose()
  return $bmp
}

# --- bitmap -> ICO DIB entry: BITMAPINFOHEADER + bottom-up BGRA + AND mask ----
function ConvertTo-IcoDib([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width; $h = $bmp.Height
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)

  $bw.Write([uint32]40)             # biSize
  $bw.Write([uint32]$w)             # biWidth
  $bw.Write([uint32]($h * 2))       # biHeight: XOR + AND planes stacked
  $bw.Write([uint16]1)              # biPlanes
  $bw.Write([uint16]32)             # biBitCount
  $bw.Write([uint32]0)              # biCompression = BI_RGB
  $bw.Write([uint32]($w * $h * 4))  # biSizeImage (XOR plane)
  $bw.Write([uint32]0)              # biXPPM
  $bw.Write([uint32]0)              # biYPPM
  $bw.Write([uint32]0)              # biClrUsed
  $bw.Write([uint32]0)              # biClrImportant

  # XOR plane: bottom-up rows of BGRA. Format32bppArgb is laid out B,G,R,A in
  # memory with straight alpha, exactly what a BI_RGB icon entry wants.
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $row = New-Object byte[] ($w * 4)
  for ($y = $h - 1; $y -ge 0; $y--) {
    [System.Runtime.InteropServices.Marshal]::Copy([IntPtr]($data.Scan0.ToInt64() + $y * $data.Stride), $row, 0, $w * 4)
    $bw.Write($row)
  }
  $bmp.UnlockBits($data)

  # AND mask: all zeros (opaque) so the alpha channel decides transparency.
  $maskRowLen = [Math]::Ceiling($w / 32.0) * 4
  $zeros = New-Object byte[] $maskRowLen
  for ($y = 0; $y -lt $h; $y++) { $bw.Write($zeros) }

  $bw.Flush()
  $bytes = $ms.ToArray()
  $bw.Dispose(); $ms.Dispose()
  # Comma wrapper: prevents PowerShell from unrolling the Byte[] into single
  # bytes on output (an unrolled 270k-element Object[] is useless downstream).
  return ,$bytes
}

# --- assemble the ICO ---------------------------------------------------------
$entries = @()
foreach ($sz in $sizes) {
  $bmp = New-SealBitmap $sz
  $dib = ConvertTo-IcoDib $bmp
  if (-not $dib -or $dib.Length -lt 40) { throw "DIB for size ${sz} came out empty ($($dib.Length) bytes) - assembly bug" }
  $entries += , $dib
  $bmp.Dispose()
  "  size ${sz}: DIB $($dib.Length) bytes"
}

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([uint16]0)              # reserved
$bw.Write([uint16]1)              # type: icon
$bw.Write([uint16]$sizes.Count)   # image count

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $sz = $sizes[$i]
  $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))  # width  (0 = 256)
  $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))  # height (0 = 256)
  $bw.Write([byte]0)              # palette colours
  $bw.Write([byte]0)              # reserved
  $bw.Write([uint16]1)            # colour planes
  $bw.Write([uint16]32)           # bits per pixel
  $bw.Write([uint32]$entries[$i].Length)
  $bw.Write([uint32]$offset)
  $offset += $entries[$i].Length
}
foreach ($e in $entries) { $bw.Write($e) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
$bw.Dispose(); $out.Dispose()
"wrote $icoPath ($([math]::Round((Get-Item $icoPath).Length / 1KB)) KB, $($sizes.Count) BMP sizes)"

# Mirror into dist so the shortcuts (which point at dist) pick it up now.
$distDir = Join-Path $root "dist"
if (Test-Path -LiteralPath $distDir) {
  Copy-Item -LiteralPath $icoPath -Destination $distDir -Force
  "mirrored into $distDir"
}

# --- re-stamp every Cupbearer shortcut and flush the shell icon cache --------
$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")
$startup = [Environment]::GetFolderPath("Startup")
$targets = @(
  (Join-Path $desktop "Cupbearer.url"),
  (Join-Path $desktop "Cupbearer.lnk"),
  (Join-Path $programs "Cupbearer.url"),
  (Join-Path $programs "Cupbearer.lnk"),
  (Join-Path $programs "Cupbearer Notifications.lnk"),
  (Join-Path $startup "Cupbearer.url"),
  (Join-Path $startup "Cupbearer.lnk")
)
$distIco = Join-Path $distDir "cupbearer.ico"
if (-not (Test-Path -LiteralPath $distIco)) { $distIco = $icoPath }

$sh = New-Object -ComObject WScript.Shell
foreach ($path in $targets) {
  if (-not (Test-Path -LiteralPath $path)) { continue }
  if ($path -like "*.url") {
    $lines = @(Get-Content -LiteralPath $path | Where-Object { $_ -notmatch '^(IconFile|IconIndex)=' -and $_.Trim() -ne '' })
    $lines += "IconFile=$distIco"
    $lines += "IconIndex=0"
    Set-Content -LiteralPath $path -Value $lines -Encoding ASCII
    "icon set on: $path"
  } else {
    $sc = $sh.CreateShortcut($path)
    $sc.IconLocation = "$distIco,0"
    $sc.Save()
    "icon set on: $path"
  }
}
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($sh)

# Explorer caches shortcut icons aggressively; both of these poke the cache.
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class IcoCache {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
'@
try {
  Add-Type -TypeDefinition $sig
  [IcoCache]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) # SHCNE_ASSOCCHANGED
} catch {}
Start-Process -FilePath "ie4uinit.exe" -ArgumentList "-show" -NoNewWindow -Wait
"icon cache refreshed"
