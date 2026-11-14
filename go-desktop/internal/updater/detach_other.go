//go:build !windows

package updater

import "os/exec"

func detach(*exec.Cmd) {}
