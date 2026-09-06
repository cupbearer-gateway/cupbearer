# Build cupbearer.ico from the favicon geometry (32x32 viewBox) at every size
# Windows asks for, then assign it to the desktop + Start Menu + Startup
# shortcuts. Shortcuts are a mix of .url and .lnk, and the two need different
# treatment: .url is an INI file, .lnk goes through WScript.Shell.

Add-Type -AssemblyName System.Drawing

# Palette, kept in step with ui/src/index.css and ui/public/favicon.svg.
$COL_BASE       = [System.Drawing.Color]::FromArgb(255, 8, 9, 10)      # --color-base
$COL_ACCENT     = [System.Drawing.Color]::FromArgb(255, 113, 112, 255) # --color-accent
$COL_ACCENT_SFT = [System.Drawing.Color]::FromArgb(255, 155, 155, 255) # --color-accent-soft
$COL_EDGE       = [System.Drawing.Color]::FromArgb(15, 255, 255, 255)  # 6% white hairline

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# Draws the mark at an arbitrary pixel size. All coordinates are expressed in
# the SVG's 32-unit space and scaled once, so every size stays identical in
# proportion rather than drifting.
function New-CupbearerBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = $size / 32.0
  $g.ScaleTransform($s, $s)

  # Rounded dark tile + hairline, so the mark reads on any wallpaper.
  $tile = New-RoundedPath 0 0 32 32 7
  $tileBrush = New-Object System.Drawing.SolidBrush $COL_BASE
  $g.FillPath($tileBrush, $tile)
  $edgePen = New-Object System.Drawing.Pen $COL_EDGE, (1.0 / $s)
  $g.DrawPath($edgePen, $tile)

  # Three lanes converging, each fading in from the left along its own run.
  $laneRect = New-Object System.Drawing.RectangleF 3, 0, 21, 32
  $laneBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $laneRect,
    [System.Drawing.Color]::FromArgb(51, $COL_ACCENT),
    [System.Drawing.Color]::FromArgb(242, $COL_ACCENT),
    [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
  $midBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $laneRect,
    [System.Drawing.Color]::FromArgb(89, $COL_ACCENT_SFT),
    [System.Drawing.Color]::FromArgb(255, $COL_ACCENT_SFT),
    [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)

  $lane = New-Object System.Drawing.Pen $laneBrush, 2.4
  $lane.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $lane.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $mid = New-Object System.Drawing.Pen $midBrush, 2.4
  $mid.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $mid.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  # M4 7 C13 7, 13 16, 22 16   /   M4 25 C13 25, 13 16, 22 16   /   M4 16 L22 16
  $g.DrawBezier($lane, 4, 7, 13, 7, 13, 16, 22, 16)
  $g.DrawBezier($lane, 4, 25, 13, 25, 13, 16, 22, 16)
  $g.DrawLine($mid, 4, 16, 22, 16)

  # The outbound node: cx 24.5, cy 16, r 3.6, knocked out from the lanes by a
  # base-coloured ring so the convergence point stays legible at 16px.
  $dotBrush = New-Object System.Drawing.SolidBrush $COL_ACCENT_SFT
  $dotPen = New-Object System.Drawing.Pen $COL_BASE, 1.5
  $g.FillEllipse($dotBrush, 20.9, 12.4, 7.2, 7.2)
  $g.DrawEllipse($dotPen, 20.9, 12.4, 7.2, 7.2)

  foreach ($d in @($g, $tile, $tileBrush, $edgePen, $laneBrush, $midBrush, $lane, $mid, $dotBrush, $dotPen)) {
    $d.Dispose()
  }
  return $bmp
}

# Multi-image ICO. Windows picks per context: 16 in title bars, 32 on the
# desktop, 48 in Explorer lists, 256 for extra-large tiles. A single 256 entry
# forces Windows to downscale, which is what made the old icon look muddy.
function New-CupbearerIco {
  $sizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
  $pngs = @()
  foreach ($sz in $sizes) {
    $bmp = New-CupbearerBitmap $sz
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
  }

  $out = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($out)
  $bw.Write([uint16]0)              # reserved
  $bw.Write([uint16]1)              # type: icon
  $bw.Write([uint16]$sizes.Count)   # image count

  # Directory entries are fixed-width, so every offset is known up front.
  $offset = 6 + (16 * $sizes.Count)
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))  # width  (0 = 256)
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))  # height (0 = 256)
    $bw.Write([byte]0)              # palette colours
    $bw.Write([byte]0)              # reserved
    $bw.Write([uint16]1)            # colour planes
    $bw.Write([uint16]32)           # bits per pixel
    $bw.Write([uint32]$pngs[$i].Length)
    $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
  }
  foreach ($png in $pngs) { $bw.Write($png) }

  $bw.Flush()
  $ico = $out.ToArray()
  $bw.Dispose()
  $out.Dispose()
  return $ico
}

# Canonical copies live in ui/public, NOT in dist. vite.config.js builds with
# emptyOutDir, so anything written straight into dist is deleted by the next
# `npm run build` — which is exactly how the desktop and toast icons went
# missing once. Everything in ui/public is copied into dist by the build, so
# putting them there makes them survive it.
#
# Paths derive from $PSScriptRoot rather than being hardcoded, so running this
# from a stale copy of the tree cannot write into the live deployment.
$root = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $root "ui\public"
$distDir = Join-Path $root "dist"

$icoPath = Join-Path $publicDir "cupbearer.ico"
$ico = New-CupbearerIco
[System.IO.File]::WriteAllBytes($icoPath, $ico)
"wrote $icoPath ($($ico.Length) bytes, 10 sizes)"

# The toast logo: a square PNG carried inside the notification payload. Windows
# renders the Win32 toast app icon lazily (and sometimes blank); this explicit
# image is what scripts/toast.ps1 embeds via <image appLogoOverride>.
$pngPath = Join-Path $publicDir "cupbearer-toast.png"
$bmp = New-CupbearerBitmap 96
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"wrote $pngPath"

# Mirror into dist now so the shortcuts work immediately without waiting for a
# UI rebuild. The build would copy these anyway; this just removes the ordering
# dependency between "changed the logo" and "ran npm run build".
if (Test-Path -LiteralPath $distDir) {
  Copy-Item -LiteralPath $icoPath -Destination $distDir -Force
  Copy-Item -LiteralPath $pngPath -Destination $distDir -Force
  "mirrored both into $distDir"
}

# Shortcuts point at dist, which is served by the gateway and is the path that
# already exists in every .url/.lnk written so far.
$icoPath = Join-Path $distDir "cupbearer.ico"

# --------------------------------------------------------------- shortcuts ---
# .url files are plain INI: rewrite IconFile/IconIndex in place. .lnk files need
# the COM interface. Both kinds exist, which is why an .lnk-only loop silently
# left the desktop icon stale.

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

$sh = New-Object -ComObject WScript.Shell
foreach ($path in $targets) {
  if (-not (Test-Path -LiteralPath $path)) { continue }

  if ($path -like "*.url") {
    $lines = @(
      Get-Content -LiteralPath $path |
        Where-Object { $_ -notmatch '^(IconFile|IconIndex)=' -and $_.Trim() -ne '' }
    )
    $lines += "IconFile=$icoPath"
    $lines += "IconIndex=0"
    Set-Content -LiteralPath $path -Value $lines -Encoding ASCII
    "icon set on: $path"
  }
  else {
    $sc = $sh.CreateShortcut($path)
    $sc.IconLocation = "$icoPath,0"
    $sc.Save()
    "icon set on: $path"
  }
}
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($sh)

# Explorer caches shortcut icons aggressively; without this the old bitmap
# survives until the next logon.
Start-Process -FilePath "ie4uinit.exe" -ArgumentList "-show" -NoNewWindow -Wait
"icon cache refreshed"
