# Fetches a libmpv Windows build and builds the MSVC import library.
# Run once per checkout: powershell -ExecutionPolicy Bypass -File scripts/fetch-libmpv.ps1
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "src-tauri\libmpv"
$feed = "https://sourceforge.net/projects/mpv-player-windows/rss?path=/libmpv"

New-Item -ItemType Directory -Force $dest | Out-Null

if ((Test-Path (Join-Path $dest "mpv.lib")) -and (Test-Path (Join-Path $dest "libmpv-2.dll"))) {
  Write-Host "libmpv already present in $dest"
  exit 0
}

Write-Host "Resolving the latest libmpv build"
[xml]$rss = (Invoke-WebRequest -UseBasicParsing $feed).Content
$item = $rss.rss.channel.item |
  Where-Object { $_.link -match "mpv-dev-x86_64-\d" } |
  Select-Object -First 1
if (-not $item) { throw "No x86_64 libmpv build found in the feed." }

$tmp = Join-Path $env:TEMP "duvy-libmpv"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $tmp | Out-Null
$archive = Join-Path $tmp "mpv-dev.7z"

Write-Host "Downloading $($item.title.InnerText)"
Invoke-WebRequest -UseBasicParsing $item.link -OutFile $archive
# SourceForge can answer with an HTML interstitial that meta-refreshes to the real file.
if ((Get-Item $archive).Length -lt 1MB) {
  $next = [regex]::Match((Get-Content $archive -Raw), '(?i)url=([^"]+)"').Groups[1].Value -replace '&amp;', '&'
  if (-not $next) { throw "Unexpected download payload from SourceForge." }
  Invoke-WebRequest -UseBasicParsing $next -OutFile $archive
}
# bsdtar (shipped with Windows 10+) reads 7z.
tar.exe -xf $archive -C $tmp

$dll = Join-Path $tmp "libmpv-2.dll"
if (-not (Test-Path $dll)) { throw "The archive did not contain libmpv-2.dll" }

$lib = Get-ChildItem "${env:ProgramFiles(x86)}\Microsoft Visual Studio" -Recurse -Filter lib.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "Hostx64\\x64" } |
  Select-Object -First 1
if (-not $lib) { throw "lib.exe not found; install the MSVC build tools." }

$dumpbin = Join-Path $lib.DirectoryName "dumpbin.exe"
$def = Join-Path $tmp "libmpv.def"
$names = & $dumpbin /nologo /exports $dll |
  Where-Object { $_ -match "^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)\s*$" } |
  ForEach-Object { $matches[1] }
if (-not $names) { throw "No exports found in libmpv-2.dll" }

Set-Content $def ("LIBRARY libmpv-2.dll`nEXPORTS`n" + (($names | ForEach-Object { "  $_" }) -join "`n") + "`n") -Encoding ascii
& $lib.FullName /nologo /def:$def /out:"$dest\mpv.lib" /machine:x64
if ($LASTEXITCODE -ne 0) { throw "lib.exe failed" }

Copy-Item $dll (Join-Path $dest "libmpv-2.dll") -Force
Write-Host "Wrote $dest\mpv.lib and $dest\libmpv-2.dll"
Write-Host "Check the build's license before shipping: GPL builds cannot be bundled in a closed-source app."
