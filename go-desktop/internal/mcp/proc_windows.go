//go:build windows

package mcp

import (
	"os/exec"
	"strconv"
	"syscall"
)

func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	k := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	hide(k)
	if k.Run() != nil {
		_ = cmd.Process.Kill()
	}
}
