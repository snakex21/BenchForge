const fs = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { app } = require('electron')
const { getAppBasePath, getDataPath } = require('./paths.cjs')
const { DEFAULT_REPO, downloadLatestAssetToDir } = require('./updateChecker.cjs')

function buildUpdaterScript() {
  return `param(
  [string]$AppDir,
  [string]$ZipPath,
  [string]$ExeName,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
function Log([string]$Message) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath $LogPath -Value "[$stamp] $Message"
}

try {
  Start-Sleep -Seconds 2
  $UpdatesDir = Join-Path $AppDir 'data\\updates'
  $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Staging = Join-Path $UpdatesDir "staging-$Stamp"
  $Backup = Join-Path $UpdatesDir "backup-$Stamp"
  New-Item -ItemType Directory -Force -Path $Staging, $Backup | Out-Null
  Log "Extracting $ZipPath to $Staging"
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $Staging -Force

  $SourceExe = Get-ChildItem -LiteralPath $Staging -Filter $ExeName -Recurse -File | Select-Object -First 1
  if (-not $SourceExe) { throw "Could not find $ExeName inside update archive." }
  $SourceDir = $SourceExe.Directory.FullName
  Log "Source directory: $SourceDir"

  Log "Backing up current app files to $Backup"
  Get-ChildItem -LiteralPath $AppDir -Force | Where-Object { $_.Name -ne 'data' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Backup -Recurse -Force
  }

  Log "Removing old app files"
  Get-ChildItem -LiteralPath $AppDir -Force | Where-Object { $_.Name -ne 'data' } | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  }

  Log "Copying new app files"
  Get-ChildItem -LiteralPath $SourceDir -Force | Where-Object { $_.Name -ne 'data' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $AppDir -Recurse -Force
  }

  Remove-Item -LiteralPath $Staging -Recurse -Force
  $TargetExe = Join-Path $AppDir $ExeName
  Log "Starting $TargetExe"
  Start-Process -FilePath $TargetExe
  Log "Update applied successfully."
} catch {
  Log "ERROR: $($_.Exception.Message)"
  try {
    if ((Test-Path -LiteralPath $Backup) -and -not (Test-Path -LiteralPath (Join-Path $AppDir $ExeName))) {
      Log "Attempting rollback from $Backup"
      Get-ChildItem -LiteralPath $Backup -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $AppDir -Recurse -Force
      }
    }
  } catch {
    Log "ROLLBACK ERROR: $($_.Exception.Message)"
  }
}
`.trimStart()
}

async function applyPortableUpdate({ repo = DEFAULT_REPO, token = null, currentVersion = app.getVersion(), assetName = null } = {}) {
  if (!app.isPackaged && process.env.BENCHFORGE_ALLOW_DEV_UPDATE !== '1') {
    throw new Error('Portable self-update is only available in packaged builds.')
  }

  const appDir = getAppBasePath()
  const dataDir = getDataPath()
  const updatesDir = path.join(dataDir, 'updates')
  const downloadsDir = path.join(updatesDir, 'downloads')
  const scriptsDir = path.join(updatesDir, 'scripts')
  await fs.mkdir(downloadsDir, { recursive: true })
  await fs.mkdir(scriptsDir, { recursive: true })

  const downloaded = await downloadLatestAssetToDir({ repo, token, currentVersion, assetName, kind: 'zip', destinationDir: downloadsDir })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const scriptPath = path.join(scriptsDir, `apply-update-${stamp}.ps1`)
  const logPath = path.join(updatesDir, `apply-update-${stamp}.log`)
  await fs.writeFile(scriptPath, buildUpdaterScript(), 'utf8')

  const exeName = path.basename(process.execPath)
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-AppDir', appDir,
    '-ZipPath', downloaded.filePath,
    '-ExeName', exeName,
    '-LogPath', logPath,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  setTimeout(() => app.quit(), 750)
  return {
    ok: true,
    willQuit: true,
    appDir,
    dataDir,
    scriptPath,
    logPath,
    downloaded,
  }
}

module.exports = { applyPortableUpdate }
