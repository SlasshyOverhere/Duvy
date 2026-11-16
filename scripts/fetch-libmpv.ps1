param([switch]$SelfTest)

# Fetches the pinned libmpv Windows build and builds the MSVC import library.
# Run once per checkout: powershell -ExecutionPolicy Bypass -File scripts/fetch-libmpv.ps1
$ErrorActionPreference = "Stop"

# Pinned build: mpv v0.42.0-5-g55d3feb45, x86_64. To bump: download the new file,
# check its published MD5 on SourceForge, then update both values here.
$archiveName = "mpv-dev-x86_64-20261108-git-55d3feb45c.7z"
$archiveSha256 = "7C147CB7CEABA717414E782EF4398DE728F679DB6E86DAAA8AEB175670CB7994"
# sourceforge.net and its *.dl mirror hosts, nothing else.
$allowedHost = '(^|\.)sourceforge\.net$'

function Assert-Hash([string]$path, [string]$expected) {
  $actual = (Get-FileHash $path -Algorithm SHA256).Hash
  if ($actual -ne $expected) {
    throw "libmpv archive checksum mismatch: expected $expected, got $actual. Nothing was written. Verify the file by hand, then update `$archiveSha256 in scripts/fetch-libmpv.ps1."
  }
}

function Assert-Url([string]$url) {
  $uri = $null
  if (-not [uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -ne "https" -or $uri.Host -notmatch $allowedHost) {
    throw "Refusing to follow an unexpected download URL: $url"
  }
}

if ($SelfTest) {
  $probe = Join-Path $env:TEMP "duvy-hash-selftest"
  Set-Content $probe "selftest" -NoNewline
  $good = (Get-FileHash $probe -Algorithm SHA256).Hash
  Assert-Hash $probe $good
  $rejected = $false
  try { Assert-Hash $probe ("0" * 64) } catch { $rejected = $true }
  Remove-Item $probe -Force
  if (-not $rejected) { throw "the checksum gate accepted a wrong hash" }
  Write-Host "Self-test passed: the pinned hash matches and a wrong hash fails closed."
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "src-tauri\libmpv"

New-Item -ItemType Directory -Force $dest | Out-Null

if ((Test-Path (Join-Path $dest "mpv.lib")) -and (Test-Path (Join-Path $dest "libmpv-2.dll"))) {
  Write-Host "libmpv already present in $dest"
  exit 0
}

$tmp = Join-Path $env:TEMP "duvy-libmpv"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $tmp | Out-Null
$archive = Join-Path $tmp "mpv-dev.7z"

Write-Host "Downloading $archiveName"
$url = "https://sourceforge.net/projects/mpv-player-windows/files/libmpv/$archiveName/download"
Invoke-WebRequest -UseBasicParsing $url -OutFile $archive
# SourceForge can answer with an HTML interstitial that meta-refreshes to the real file.
if ((Get-Item $archive).Length -lt 1MB) {
  $next = [regex]::Match((Get-Content $archive -Raw), '(?i)url=([^"]+)"').Groups[1].Value -replace '&amp;', '&'
  if (-not $next) { throw "Unexpected download payload from SourceForge." }
  Assert-Url $next
  Invoke-WebRequest -UseBasicParsing $next -OutFile $archive
}
# The pinned hash is the only thing that makes this binary trusted.
Assert-Hash $archive $archiveSha256
# bsdtar (shipped with Windows 10+) reads 7z.
# The full path on purpose: a Git-for-Windows shell puts an MSYS tar first on
# PATH, and that one cannot read a Windows path.
& "$env:SystemRoot\System32\tar.exe" -xf $archive -C $tmp

$dll = Join-Path $tmp "libmpv-2.dll"
if (-not (Test-Path $dll)) { throw "The archive did not contain libmpv-2.dll" }

# vswhere locates any VS install; older layouts keep it under Program Files (x86).
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1 }
$lib = if ($vs) {
  Get-ChildItem (Join-Path $vs "VC\Tools\MSVC") -Recurse -Filter lib.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "Hostx64\\x64" } |
    Select-Object -First 1
}
if (-not $lib) {
  $lib = Get-ChildItem "$env:ProgramFiles\Microsoft Visual Studio", "${env:ProgramFiles(x86)}\Microsoft Visual Studio" -Recurse -Filter lib.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "Hostx64\\x64" } |
    Select-Object -First 1
}
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

try {
  Copy-Item $dll (Join-Path $dest "libmpv-2.dll") -Force -ErrorAction Stop
} catch {
  Write-Warning "Could not copy libmpv-2.dll into $dest; playback will fail at runtime. $_"
  throw
}
Write-Host "Wrote $dest\mpv.lib and $dest\libmpv-2.dll"
Write-Host "Check the build's license before shipping: GPL builds cannot be bundled in a closed-source app."
