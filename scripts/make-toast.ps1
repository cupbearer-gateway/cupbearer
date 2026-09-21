# Rebuild ui/public/cupbearer-toast.png from the canonical logo (ui/public/logo.png).
#
# The toast app logo (scripts/toast.ps1 → <image placement="appLogoOverride">)
# renders at roughly 48x48 logical pixels. The old toast PNG carried the seal
# at ~40% of a 96px canvas — an ~19px emblem at toast scale, which read as a
# cropped/shrunken icon. This derives the toast image from the logo instead:
# crop the seal tight, scale it to fill a rounded tile at full toast
# resolution, transparent outside the tile corners.
#
# Single source of truth: ui/public/logo.png IS the brand. Re-run this after
# any logo change. (scripts/make-icon.ps1 predates the current seal artwork —
# do not run it to regenerate brand assets.)

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $root "ui\public\logo.png"
$dstPath = Join-Path $root "ui\public\cupbearer-toast.png"

$size = 256          # toast render size; Windows downscales per DPI
$fill = 0.88         # seal fills this share of the tile
$radiusFrac = 0.20   # corner radius as a share of the tile

$logo = [System.Drawing.Bitmap]::FromFile($srcPath)

# --- locate the seal: gold pixels are warm and bright on a near-black ground
$minx = $logo.Width; $miny = $logo.Height; $maxx = 0; $maxy = 0
$stride = 4
for ($y = 0; $y -lt $logo.Height; $y += $stride) {
  for ($x = 0; $x -lt $logo.Width; $x += $stride) {
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

# Square crop around the seal, centred, with the seal filling $fill of the tile.
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

# Rounded-corner clip so the tile reads as an app icon on light and dark toasts.
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

$bmp.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"wrote $dstPath ($size x $size, seal fills $([int]($fill * 100))% of the tile)"

# Mirror into dist so the live gateway picks it up without waiting for a UI build.
$distDir = Join-Path $root "dist"
if (Test-Path -LiteralPath $distDir) {
  Copy-Item -LiteralPath $dstPath -Destination $distDir -Force
  "mirrored into $distDir"
}
