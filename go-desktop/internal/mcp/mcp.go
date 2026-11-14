// Package mcp ports electron/mcpRuntime.cjs: a minimal stdio JSON-RPC MCP
// client (Content-Length framing) for tools/list and tools/call against
// user-configured MCP servers.
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
)

const (
	defaultTimeout = 20 * time.Second
	maxStderr      = 64 * 1024
	maxMessage     = 32 << 20
)

// Server is a sanitised MCP server definition.
type Server struct {
	ID      string
	Name    string
	Command string
	Args    []string
	Cwd     string
	Env     map[string]string
	Timeout time.Duration
}

// Sanitize mirrors sanitizeServers (drops disabled/incomplete entries).
func Sanitize(servers any) []Server {
	out := []Server{}
	for _, item := range jsv.AsArr(servers) {
		s := jsv.AsObj(item)
		if s == nil || !jsv.Truthy(s["id"]) || !jsv.Truthy(s["command"]) || jsv.Truthy(s["disabled"]) {
			continue
		}
		srv := Server{
			ID:      jsv.String(s["id"]),
			Name:    jsv.Str(jsv.Or(s["name"], s["id"])),
			Command: jsv.String(s["command"]),
			Env:     map[string]string{},
		}
		for _, a := range jsv.AsArr(s["args"]) {
			srv.Args = append(srv.Args, jsv.String(a))
		}
		if jsv.Truthy(s["cwd"]) {
			srv.Cwd = jsv.String(s["cwd"])
		}
		for k, v := range jsv.AsObj(s["env"]) {
			srv.Env[k] = jsv.String(v)
		}
		ms := jsv.Number(jsv.Or(s["timeoutMs"], float64(defaultTimeout/time.Millisecond)))
		if ms != ms { // NaN
			ms = float64(defaultTimeout / time.Millisecond)
		}
		if ms < 1000 {
			ms = 1000
		}
		if ms > 120000 {
			ms = 120000
		}
		srv.Timeout = time.Duration(ms) * time.Millisecond
		out = append(out, srv)
	}
	return out
}

type client struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	mu      sync.Mutex
	nextID  int
	pending map[int]chan rpcResponse
	stderr  *tailBuffer
	closed  chan struct{}
	exitErr error
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
	raw json.RawMessage
}

type tailBuffer struct {
	mu sync.Mutex
	b  []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	t.b = append(t.b, p...)
	if len(t.b) > maxStderr {
		t.b = t.b[len(t.b)-maxStderr:]
	}
	t.mu.Unlock()
	return len(p), nil
}
func (t *tailBuffer) String() string { t.mu.Lock(); defer t.mu.Unlock(); return string(t.b) }

var contentLength = regexp.MustCompile(`(?i)Content-Length:\s*(\d+)`)

func start(s Server) (*client, error) {
	cmd := exec.Command(s.Command, s.Args...)
	cmd.Dir = s.Cwd
	env := os.Environ()
	for k, v := range s.Env {
		env = append(env, k+"="+v)
	}
	cmd.Env = env
	hide(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	c := &client{cmd: cmd, stdin: stdin, nextID: 1, pending: map[int]chan rpcResponse{}, stderr: &tailBuffer{}, closed: make(chan struct{})}
	cmd.Stderr = c.stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go c.readLoop(stdout)
	go func() {
		c.exitErr = cmd.Wait()
		close(c.closed)
	}()
	return c, nil
}

func (c *client) readLoop(r io.Reader) {
	br := bufio.NewReader(r)
	for {
		header := ""
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if strings.TrimRight(line, "\r\n") == "" {
				break
			}
			header += line
		}
		m := contentLength.FindStringSubmatch(header)
		if m == nil {
			continue
		}
		n, _ := strconv.Atoi(m[1])
		if n <= 0 || n > maxMessage {
			return
		}
		body := make([]byte, n)
		if _, err := io.ReadFull(br, body); err != nil {
			return
		}
		var msg struct {
			ID *json.RawMessage `json:"id"`
		}
		if json.Unmarshal(body, &msg) != nil || msg.ID == nil {
			continue
		}
		var id int
		if json.Unmarshal(*msg.ID, &id) != nil {
			continue
		}
		var resp rpcResponse
		_ = json.Unmarshal(body, &resp)
		resp.raw = body
		c.mu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if ch != nil {
			ch <- resp
		}
	}
}

func (c *client) send(msg any) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := fmt.Fprintf(c.stdin, "Content-Length: %d\r\n\r\n", len(body)); err != nil {
		return err
	}
	_, err = c.stdin.Write(body)
	return err
}

func (c *client) request(ctx context.Context, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	c.mu.Lock()
	id := c.nextID
	c.nextID++
	ch := make(chan rpcResponse, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case resp := <-ch:
		if resp.Error != nil {
			msg := resp.Error.Message
			if msg == "" {
				msg = string(resp.raw)
			}
			return nil, errors.New(msg)
		}
		return resp.Result, nil
	case <-t.C:
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("MCP request timed out: %s", method)
	case <-c.closed:
		code := -1
		if c.cmd.ProcessState != nil {
			code = c.cmd.ProcessState.ExitCode()
		}
		return nil, errors.New(strings.TrimSpace(fmt.Sprintf("MCP server exited with code %d. %s", code, c.stderr.String())))
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *client) close() {
	_ = c.stdin.Close()
	select {
	case <-c.closed:
	case <-time.After(500 * time.Millisecond):
		killTree(c.cmd)
		<-c.closed
	}
}

func withClient(ctx context.Context, s Server, fn func(*client) (json.RawMessage, error)) (json.RawMessage, error) {
	c, err := start(s)
	if err != nil {
		return nil, err
	}
	defer c.close()
	if _, err := c.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2024-11-05", "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "BenchForge", "version": "1.0.0"},
	}, s.Timeout); err != nil {
		return nil, err
	}
	if err := c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized", "params": map[string]any{}}); err != nil {
		return nil, err
	}
	return fn(c)
}

// ListTools mirrors listMcpTools.
func ListTools(ctx context.Context, servers any) []jsv.Obj {
	out := []jsv.Obj{}
	for _, s := range Sanitize(servers) {
		info := jsv.Obj{"id": s.ID, "name": s.Name}
		raw, err := withClient(ctx, s, func(c *client) (json.RawMessage, error) {
			return c.request(ctx, "tools/list", map[string]any{}, s.Timeout)
		})
		if err != nil {
			out = append(out, jsv.Obj{"server": info, "ok": false, "error": err.Error(), "tools": []any{}})
			continue
		}
		var payload struct {
			Tools []any `json:"tools"`
		}
		_ = json.Unmarshal(raw, &payload)
		if payload.Tools == nil {
			payload.Tools = []any{}
		}
		out = append(out, jsv.Obj{"server": info, "ok": true, "tools": payload.Tools})
	}
	return out
}

// CallTool mirrors callMcpTool.
func CallTool(ctx context.Context, servers any, serverID, toolName string, args any) (jsv.Obj, error) {
	var srv *Server
	for _, s := range Sanitize(servers) {
		if s.ID == serverID {
			s := s
			srv = &s
			break
		}
	}
	if srv == nil {
		return nil, fmt.Errorf("MCP server not found or disabled: %s", serverID)
	}
	if args == nil {
		args = map[string]any{}
	}
	raw, err := withClient(ctx, *srv, func(c *client) (json.RawMessage, error) {
		return c.request(ctx, "tools/call", map[string]any{"name": toolName, "arguments": args}, srv.Timeout)
	})
	if err != nil {
		return nil, err
	}
	var result any
	_ = json.Unmarshal(raw, &result)
	return jsv.Obj{"ok": true, "server": jsv.Obj{"id": srv.ID, "name": srv.Name}, "toolName": toolName, "result": result}, nil
}
