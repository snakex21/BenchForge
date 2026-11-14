// Package proc runs child processes with a timeout, bounded output capture
// and process-tree termination (shared by the sandbox, repo sandbox,
// environment checks and MCP).
package proc

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// MaxOutputBytes is the per-stream capture limit (256 KiB, as in the JS).
const MaxOutputBytes = 256 * 1024

// Options for Run.
type Options struct {
	Dir     string
	Env     []string // extra KEY=VALUE entries appended to the environment
	Stdin   string
	Timeout time.Duration
	// OnTimeout runs after the process tree was killed (e.g. docker rm -f).
	OnTimeout func()
}

// Result mirrors the JS runProcess result.
type Result struct {
	OK         bool   `json:"ok"`
	ExitCode   *int   `json:"exitCode"`
	TimedOut   bool   `json:"timedOut"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int64  `json:"durationMs"`
	NotFound   bool   `json:"-"`
}

type limitedBuffer struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	truncated bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	room := MaxOutputBytes - l.buf.Len()
	if room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
			l.truncated = true
		} else {
			l.buf.Write(p)
		}
	} else if len(p) > 0 {
		l.truncated = true
	}
	return len(p), nil
}

func (l *limitedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.buf.String()
	if l.truncated {
		s += "\n...[truncated]"
	}
	return s
}

// Run executes name+args without a shell.
func Run(ctx context.Context, name string, args []string, o Options) Result {
	cmd := exec.Command(name, args...)
	return run(ctx, cmd, o)
}

func run(ctx context.Context, cmd *exec.Cmd, o Options) Result {
	start := time.Now()
	cmd.Dir = o.Dir
	cmd.Env = append(os.Environ(), o.Env...)
	if cmd.SysProcAttr == nil {
		hideWindow(cmd)
	}
	var stdout, stderr limitedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.Stdin = strings.NewReader(o.Stdin)
	if err := cmd.Start(); err != nil {
		res := Result{Stderr: err.Error(), DurationMs: time.Since(start).Milliseconds()}
		res.NotFound = errors.Is(err, exec.ErrNotFound) || os.IsNotExist(err)
		return res
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var waitErr error
	timedOut := false
	select {
	case waitErr = <-done:
	case <-timer.C:
		timedOut = true
		killTree(cmd)
		waitErr = <-done
		if o.OnTimeout != nil {
			o.OnTimeout()
		}
	case <-ctx.Done():
		timedOut = true
		killTree(cmd)
		waitErr = <-done
		if o.OnTimeout != nil {
			o.OnTimeout()
		}
	}
	res := Result{TimedOut: timedOut, Stdout: stdout.String(), Stderr: stderr.String(), DurationMs: time.Since(start).Milliseconds()}
	if cmd.ProcessState != nil && !timedOut {
		code := cmd.ProcessState.ExitCode()
		res.ExitCode = &code
	}
	res.OK = waitErr == nil && !timedOut && res.ExitCode != nil && *res.ExitCode == 0
	return res
}

// RunShell executes a command line through the platform shell (used only
// for user-configured repo test commands, never for model output).
func RunShell(ctx context.Context, command string, o Options) Result {
	return run(ctx, shellCommand(command), o)
}
