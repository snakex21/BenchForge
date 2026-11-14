//go:build windows

package proc

import (
	"os/exec"
	"strconv"
	"syscall"
)

const createNoWindow = 0x08000000

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// killTree terminates the process and all of its children.
func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	hideWindow(kill)
	if err := kill.Run(); err != nil {
		_ = cmd.Process.Kill()
	}
}

func shellCommand(command string) *exec.Cmd {
	cmd := exec.Command("cmd.exe")
	hideWindow(cmd)
	cmd.SysProcAttr.CmdLine = `cmd.exe /d /s /c "` + command + `"`
	return cmd
}
