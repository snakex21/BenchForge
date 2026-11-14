//go:build windows

package updater

import (
	"os/exec"
	"syscall"
)

func detach(cmd *exec.Cmd) {
	const detachedProcess, newProcessGroup, noWindow = 0x00000008, 0x00000200, 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: detachedProcess | newProcessGroup | noWindow}
}
