// Package envcheck ports electron/systemTools.cjs (tool version probes).
package envcheck

import (
	"context"
	"strings"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/proc"
)

type candidate struct {
	cmd  string
	args []string
}

func runVersion(ctx context.Context, c candidate) jsv.Obj {
	r := proc.Run(ctx, c.cmd, c.args, proc.Options{Timeout: 5 * time.Second})
	command := strings.TrimSpace(c.cmd + " " + strings.Join(c.args, " "))
	if r.TimedOut {
		return jsv.Obj{"ok": false, "command": command, "error": "timeout", "stdout": r.Stdout, "stderr": r.Stderr}
	}
	out := strings.TrimSpace(r.Stdout + "\n" + r.Stderr)
	var version any
	if out != "" {
		version = strings.SplitN(strings.ReplaceAll(out, "\r\n", "\n"), "\n", 2)[0]
	}
	res := jsv.Obj{"ok": r.OK, "command": command, "version": version, "stdout": r.Stdout, "stderr": r.Stderr}
	if r.ExitCode != nil {
		res["exitCode"] = *r.ExitCode
	} else {
		res["exitCode"] = nil
		res["error"] = r.Stderr
	}
	return res
}

func firstOK(ctx context.Context, label string, cands []candidate, required bool) jsv.Obj {
	var attempts []any
	var errs []string
	var cmds []string
	for _, c := range cands {
		r := runVersion(ctx, c)
		attempts = append(attempts, r)
		cmds = append(cmds, r["command"].(string))
		if r["ok"] == true {
			return jsv.Obj{"label": label, "ok": true, "required": required, "command": r["command"], "version": r["version"], "attempts": attempts}
		}
		if e := jsv.Str(jsv.Or(r["error"], r["stderr"])); e != "" {
			errs = append(errs, e)
		}
	}
	msg := strings.Join(errs, " ; ")
	if msg == "" {
		msg = "not found"
	}
	return jsv.Obj{"label": label, "ok": false, "required": required, "command": strings.Join(cmds, " | "), "error": msg, "attempts": attempts}
}

// Check mirrors checkEnvironment. Node is optional in the Go build (the
// Electron build always "found" Node because it probed its own executable).
func Check(ctx context.Context) jsv.Obj {
	checks := []jsv.Obj{
		firstOK(ctx, "Node", []candidate{{"node", []string{"--version"}}}, false),
		firstOK(ctx, "npm", []candidate{{"npm.cmd", []string{"--version"}}, {"npm", []string{"--version"}}}, false),
		firstOK(ctx, "Python", []candidate{{"python", []string{"--version"}}, {"py", []string{"-3", "--version"}}, {"python3", []string{"--version"}}}, true),
		firstOK(ctx, "pytest", []candidate{{"python", []string{"-m", "pytest", "--version"}}, {"py", []string{"-3", "-m", "pytest", "--version"}}, {"python3", []string{"-m", "pytest", "--version"}}}, false),
		firstOK(ctx, "Git", []candidate{{"git", []string{"--version"}}}, true),
		firstOK(ctx, "Docker", []candidate{{"docker", []string{"--version"}}}, false),
		firstOK(ctx, "npx", []candidate{{"npx.cmd", []string{"--version"}}, {"npx", []string{"--version"}}}, false),
	}
	ok := true
	for _, c := range checks {
		if c["required"] == true && c["ok"] != true {
			ok = false
		}
	}
	return jsv.Obj{"ok": ok, "checks": checks}
}
