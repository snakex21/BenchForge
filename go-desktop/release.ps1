# Builds the release files for the Go + WebView2 app (also used by
# .github/workflows/windows-release.yml):
#   dist\BenchForge-<version>-x64.zip   (BenchForge/BenchForge.exe + LICENSE.txt)
#   dist\BenchForge-<version>-x64.exe   (the same exe, standalone)
#   dist\SHA256SUMS.txt                 (required by the in-app updater)
# Usage: powershell -ExecutionPolicy Bypass -File release.ps1 -Version 2.0.0 [-SkipUI] [-SkipBuild]
# Needs Node 22 (npm ci done in ..\frontend), Go and MinGW-w64 gcc.
# -SkipBuild packages an existing BenchForge.exe.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$SkipUI,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must be MAJOR.MINOR.PATCH, got '$Version'" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
  if (-not $SkipBuild) {
    if (-not $SkipUI) {
      Push-Location ..\frontend
      try {
        npm run build:go
        if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }
      } finally { Pop-Location }
    }
    $env:CGO_ENABLED = '1'; $env:GOOS = 'windows'; $env:GOARCH = 'amd64'
    go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=$Version" -o BenchForge.exe ./cmd/benchforge
    if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
  }
  if (Test-Path dist) { Remove-Item -Recurse -Force dist }
  New-Item -ItemType Directory -Force -Path dist | Out-Null
  $dist = (Resolve-Path dist).Path

  # Zip entries must use '/' (Windows PowerShell's Compress-Archive writes '\',
  # which other unzip tools treat as part of the file name).
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zipPath = Join-Path $dist "BenchForge-$Version-x64.zip"
  $zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
  try {
    foreach ($f in @(@((Join-Path $here 'BenchForge.exe'), 'BenchForge/BenchForge.exe'), @((Resolve-Path ..\LICENSE).Path, 'BenchForge/LICENSE.txt'))) {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f[0], $f[1], 'Optimal') | Out-Null
    }
  } finally { $zip.Dispose() }
  Copy-Item BenchForge.exe (Join-Path $dist "BenchForge-$Version-x64.exe")

  # SHA256SUMS.txt with LF line endings, so `sha256sum -c` works too.
  $lines = Get-ChildItem -File $dist -Filter 'BenchForge-*' | Sort-Object Name | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name
  }
  [System.IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'), (($lines -join "`n") + "`n"), [System.Text.Encoding]::ASCII)
  Get-Content (Join-Path $dist 'SHA256SUMS.txt')
} finally {
  Pop-Location
}
