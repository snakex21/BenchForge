package updater

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// PortableScript is the PowerShell script that swaps the app files after the
// app exits (same logic as electron/portableUpdater.cjs, data/ is kept).
const PortableScript = `param(
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
  $UpdatesDir = Join-Path $AppDir 'data\updates'
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
`

// PortablePlan describes the files used by a portable self-update.
type PortablePlan struct {
	ScriptPath string
	LogPath    string
	ExeName    string
}

// PreparePortable writes the update script into dataDir/updates/scripts.
func PreparePortable(dataDir, exePath string) (*PortablePlan, error) {
	updates := filepath.Join(dataDir, "updates")
	scripts := filepath.Join(updates, "scripts")
	if err := os.MkdirAll(scripts, 0o755); err != nil {
		return nil, err
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	plan := &PortablePlan{
		ScriptPath: filepath.Join(scripts, "apply-update-"+stamp+".ps1"),
		LogPath:    filepath.Join(updates, "apply-update-"+stamp+".log"),
		ExeName:    filepath.Base(exePath),
	}
	return plan, os.WriteFile(plan.ScriptPath, []byte(PortableScript), 0o644)
}

// Launch starts the detached PowerShell script (the caller then quits).
func (p *PortablePlan) Launch(appDir, zipPath string) error {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p.ScriptPath,
		"-AppDir", appDir, "-ZipPath", zipPath, "-ExeName", p.ExeName, "-LogPath", p.LogPath)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
