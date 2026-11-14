# Builds the release files for the Go + WebView2 app, the same way as
# .github/workflows/windows-release.yml:
#   dist\BenchForge-<version>-x64.zip   (BenchForge\BenchForge.exe + LICENSE.txt)
#   dist\BenchForge-<version>-x64.exe   (the same exe, standalone)
#   dist\SHA256SUMS.txt                 (required by the in-app updater)
# Usage: powershell -ExecutionPolicy Bypass -File release.ps1 -Version 2.0.0 [-SkipUI]
# Needs Node 22 (npm ci done in ..\frontend), Go and MinGW-w64 gcc.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$SkipUI
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must be MAJOR.MINOR.PATCH, got '$Version'" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
  if (-not $SkipUI) {
    Push-Location ..\frontend
    npm run build:go
    if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }
    Pop-Location
  }
  $env:CGO_ENABLED = '1'; $env:GOOS = 'windows'; $env:GOARCH = 'amd64'
  go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=$Version" -o BenchForge.exe ./cmd/benchforge
  if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
  if (Test-Path dist) { Remove-Item -Recurse -Force dist }
  New-Item -ItemType Directory -Force -Path dist\BenchForge | Out-Null
  Copy-Item BenchForge.exe dist\BenchForge\
  Copy-Item ..\LICENSE dist\BenchForge\LICENSE.txt
  Compress-Archive -Path dist\BenchForge -DestinationPath "dist\BenchForge-$Version-x64.zip" -CompressionLevel Optimal
  Copy-Item BenchForge.exe "dist\BenchForge-$Version-x64.exe"
  Remove-Item -Recurse -Force dist\BenchForge
  Push-Location dist
  Get-ChildItem -File BenchForge-* | Sort-Object Name | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash $_.Name -Algorithm SHA256).Hash.ToLower(), $_.Name
  } | Set-Content -Encoding ascii SHA256SUMS.txt
  Get-Content SHA256SUMS.txt
  Pop-Location
} finally {
  Pop-Location
}
