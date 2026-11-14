package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/mcp"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
	"github.com/snakex21/benchforge/go-desktop/internal/proc"
)

const (
	defaultTimeout = 10 * time.Second
	maxTimeout     = 120 * time.Second
	maxFileBytes   = 16 << 20
)

// ToolDefs is listTools().
var ToolDefs = []jsv.Obj{
	{"id": "python.run", "name": "Python runner", "description": "Runs Python code in a Docker sandbox (no network) with a timeout. Host execution only after explicit opt-in."},
	{"id": "node.run", "name": "Node runner", "description": "Runs JavaScript code in a Docker sandbox (no network) with a timeout. Host execution only after explicit opt-in."},
	{"id": "file.write", "name": "Write file", "description": "Writes a file inside the tool workdir."},
	{"id": "file.read", "name": "Read file", "description": "Reads a file from the tool workdir."},
	{"id": "file.list", "name": "List files", "description": "Lists files created in the tool workdir."},
	{"id": "image.draw_path_svg", "name": "Draw path SVG", "description": "Creates an SVG overlay/path artifact for image/maze tasks."},
	{"id": "mcp.list_tools", "name": "List MCP tools", "description": "Lists tools exposed by configured MCP servers."},
	{"id": "mcp.call", "name": "Call MCP tool", "description": "Calls a tool on a configured MCP server through stdio JSON-RPC."},
}

// Executor runs a command; replaceable in tests.
type Executor func(ctx context.Context, name string, args []string, o proc.Options) proc.Result

// Runtime executes tools.
type Runtime struct {
	Policy func() Policy
	Exec   Executor
	// DockerAvailable is probed lazily; replaceable in tests.
	DockerAvailable func(ctx context.Context) bool
}

// New returns a runtime using real processes.
func New(policy func() Policy) *Runtime {
	return &Runtime{Policy: policy, Exec: proc.Run, DockerAvailable: dockerAvailable}
}

func dockerAvailable(ctx context.Context) bool {
	r := proc.Run(ctx, "docker", []string{"version", "--format", "{{.Server.Version}}"}, proc.Options{Timeout: 8 * time.Second})
	return r.OK
}

type workdir struct {
	runID, rel, abs string
}

func randomSuffix() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func stamp() string {
	return strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
}

func createRun() (workdir, error) {
	id := "tool-run-" + stamp() + "-" + randomSuffix()
	rel := "artifacts/tools/" + id
	abs := paths.ResolveData(rel)
	if abs == "" {
		return workdir{}, errors.New("Invalid tool workdir")
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return workdir{}, err
	}
	if err := os.WriteFile(filepath.Join(abs, "tool-calls.jsonl"), nil, 0o644); err != nil {
		return workdir{}, err
	}
	return workdir{id, rel, abs}, nil
}

// resolveWorkdir only accepts existing tool/repo workdirs under artifacts/.
func resolveWorkdir(rel string) (workdir, error) {
	if rel == "" {
		return createRun()
	}
	rel = paths.ToPosix(rel)
	if !strings.HasPrefix(rel, "artifacts/") {
		return workdir{}, errors.New("Invalid tool workdir")
	}
	abs := paths.ResolveData(rel)
	if abs == "" {
		return workdir{}, errors.New("Invalid tool workdir")
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return workdir{}, err
	}
	trace := filepath.Join(abs, "tool-calls.jsonl")
	if _, err := os.Stat(trace); err != nil {
		_ = os.WriteFile(trace, nil, 0o644)
	}
	return workdir{filepath.Base(abs), rel, abs}, nil
}

// SafeChild resolves a path inside dir (no escapes, no absolute paths).
func SafeChild(dir string, requested any, fallback string) (string, error) {
	rel := jsv.Str(requested)
	if rel == "" {
		rel = fallback
	}
	rel = strings.TrimLeft(rel, `/\`)
	abs := paths.ResolveWithin(dir, rel)
	if abs == "" || abs == filepath.Clean(dir) {
		return "", errors.New("Path escapes tool workdir")
	}
	return abs, nil
}

func appendTrace(w workdir, entry jsv.Obj) {
	entry2 := jsv.Obj{"ts": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	for k, v := range entry {
		entry2[k] = v
	}
	f, err := os.OpenFile(filepath.Join(w.abs, "tool-calls.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(jsv.JSONString(entry2) + "\n")
}

// ClampTimeout mirrors clampTimeout.
func ClampTimeout(v any) time.Duration {
	f := jsv.Number(jsv.Or(v, float64(defaultTimeout/time.Millisecond)))
	if math.IsNaN(f) || math.IsInf(f, 0) || f <= 0 {
		return defaultTimeout
	}
	ms := math.Floor(f)
	if ms < 100 {
		ms = 100
	}
	if ms > float64(maxTimeout/time.Millisecond) {
		ms = float64(maxTimeout / time.Millisecond)
	}
	return time.Duration(ms) * time.Millisecond
}

// RunOptions carries trusted context (never from model output).
type RunOptions struct {
	MCPServers any
}

// Run is runTool(payload). Errors are reported in the result (ok:false).
func (r *Runtime) Run(ctx context.Context, payload jsv.Obj, opts RunOptions) jsv.Obj {
	if payload == nil {
		payload = jsv.Obj{}
	}
	tool := jsv.Str(jsv.Or(payload["tool"], payload["id"], ""))
	w, err := resolveWorkdir(jsv.Str(payload["workdir"]))
	if err != nil {
		return jsv.Obj{"ok": false, "error": err.Error()}
	}
	input := jsv.AsObj(payload["input"])
	if input == nil {
		input = payload
	}
	traceInput := jsv.Obj{}
	for k, v := range input {
		traceInput[k] = v
	}
	if code, ok := input["code"].(string); ok {
		traceInput["code"] = fmt.Sprintf("[%d chars]", len([]rune(code)))
	}
	appendTrace(w, jsv.Obj{"tool": tool, "phase": "start", "input": traceInput})

	var result jsv.Obj
	switch tool {
	case "python.run":
		result, err = r.runCode(ctx, "python", input, w)
	case "node.run":
		result, err = r.runCode(ctx, "node", input, w)
	case "file.write":
		result, err = writeFile(input, w)
	case "file.read":
		result, err = readFile(input, w)
	case "file.list":
		result, err = listFiles(w)
	case "image.draw_path_svg":
		result, err = drawPathSVG(input, w)
	case "mcp.list_tools":
		result = jsv.Obj{"ok": true, "servers": mcp.ListTools(ctx, opts.MCPServers)}
	case "mcp.call":
		serverID := jsv.Str(jsv.Or(input["serverId"], input["server_id"], ""))
		toolName := jsv.Str(jsv.Or(input["toolName"], input["tool_name"], input["name"], ""))
		if serverID == "" || toolName == "" {
			err = errors.New("mcp.call requires serverId and toolName")
		} else {
			result, err = mcp.CallTool(ctx, opts.MCPServers, serverID, toolName, jsv.Or(input["arguments"], input["args"], map[string]any{}))
		}
	default:
		err = fmt.Errorf("Unknown tool: %s", tool)
	}
	if err != nil {
		result = jsv.Obj{"ok": false, "error": err.Error()}
	}
	appendTrace(w, jsv.Obj{"tool": tool, "phase": "done", "result": result})
	_ = os.WriteFile(filepath.Join(w.abs, "last-result.json"), []byte(jsv.JSONIndent(jsv.Obj{"tool": tool, "result": result, "workdir": w.rel})), 0o644)
	out := jsv.Obj{}
	for k, v := range result {
		out[k] = v
	}
	out["workdir"] = w.rel
	out["tracePath"] = w.rel + "/tool-calls.jsonl"
	return out
}

func procToObj(res proc.Result) jsv.Obj {
	var exit any
	if res.ExitCode != nil {
		exit = *res.ExitCode
	}
	return jsv.Obj{"ok": res.OK, "exitCode": exit, "timedOut": res.TimedOut, "stdout": res.Stdout, "stderr": res.Stderr, "durationMs": res.DurationMs}
}

func (r *Runtime) runCode(ctx context.Context, lang string, input jsv.Obj, w workdir) (jsv.Obj, error) {
	code := jsv.Str(input["code"])
	userFile, bootFile, boot := "main.py", "__benchforge_bootstrap.py", pythonBootstrap("main.py")
	if lang == "node" {
		userFile, bootFile, boot = "main.js", "__benchforge_bootstrap.cjs", nodeBootstrap("main.js")
	}
	if err := os.WriteFile(filepath.Join(w.abs, userFile), []byte(code), 0o644); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(w.abs, bootFile), []byte(boot), 0o644); err != nil {
		return nil, err
	}
	timeout := ClampTimeout(input["timeoutMs"])
	stdin := jsv.Str(input["stdin"])
	policy := r.Policy()
	var res proc.Result
	extra := jsv.Obj{"sandbox": string(policy.Mode())}
	switch policy.Mode() {
	case ModeDocker:
		if r.DockerAvailable != nil && !r.DockerAvailable(ctx) {
			out := jsv.Obj{"ok": false, "exitCode": nil, "timedOut": false, "stdout": "", "stderr": "Docker is not available. Start Docker Desktop (the default, isolated sandbox) or explicitly enable host execution in Settings.", "durationMs": 0, "docker": true, "sandbox": "docker-unavailable"}
			writeOutputs(w, out)
			return out, nil
		}
		image, interp := PythonImage, "python"
		if lang == "node" {
			image, interp = NodeImage, "node"
		}
		name := "benchforge-sbx-" + randomSuffix() + randomSuffix()
		args := DockerArgs(name, w.abs, image, interp, bootFile)
		res = r.Exec(ctx, "docker", args, proc.Options{Dir: w.abs, Timeout: timeout, Stdin: stdin, OnTimeout: func() {
			_ = r.Exec(context.Background(), "docker", []string{"rm", "-f", name}, proc.Options{Timeout: 15 * time.Second})
		}})
		extra["docker"] = true
		extra["image"] = image
	case ModeHost:
		env := []string{"BENCHFORGE_SANDBOX=1", "NO_PROXY=*", "no_proxy=*"}
		if lang == "node" {
			res = r.Exec(ctx, "node", []string{bootFile}, proc.Options{Dir: w.abs, Timeout: timeout, Stdin: stdin, Env: env})
		} else {
			for _, c := range [][]string{{"python", bootFile}, {"py", "-3", bootFile}, {"python3", bootFile}} {
				res = r.Exec(ctx, c[0], c[1:], proc.Options{Dir: w.abs, Timeout: timeout, Stdin: stdin, Env: env})
				if !res.NotFound {
					break
				}
			}
		}
		extra["hostExecution"] = true
	default:
		out := jsv.Obj{"ok": false, "exitCode": nil, "timedOut": false, "stdout": "", "stderr": RefusedMessage, "durationMs": 0, "sandbox": string(ModeRefused)}
		writeOutputs(w, out)
		return out, nil
	}
	out := procToObj(res)
	for k, v := range extra {
		out[k] = v
	}
	writeOutputs(w, out)
	return out, nil
}

// DockerArgs builds the hardened `docker run` command line.
func DockerArgs(name, hostDir, image, interpreter, script string) []string {
	volume := paths.ToPosix(hostDir) + ":/workspace"
	return []string{
		"run", "--rm", "--name", name,
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--pids-limit", "256",
		"--memory", "512m", "--memory-swap", "512m",
		"--cpus", "1",
		"--read-only", "--tmpfs", "/tmp:rw,size=64m",
		"--user", "65534:65534",
		"-e", "HOME=/tmp", "-e", "BENCHFORGE_SANDBOX=1",
		"-v", volume, "-w", "/workspace",
		"-i", image, interpreter, script,
	}
}

func writeOutputs(w workdir, out jsv.Obj) {
	_ = os.WriteFile(filepath.Join(w.abs, "stdout.txt"), []byte(jsv.Str(out["stdout"])), 0o644)
	_ = os.WriteFile(filepath.Join(w.abs, "stderr.txt"), []byte(jsv.Str(out["stderr"])), 0o644)
}

func trimOutput(s string) string {
	if len(s) <= proc.MaxOutputBytes {
		return s
	}
	return s[:proc.MaxOutputBytes] + "\n...[truncated]"
}

func writeFile(input jsv.Obj, w workdir) (jsv.Obj, error) {
	target, err := SafeChild(w.abs, input["path"], "file.txt")
	if err != nil {
		return nil, err
	}
	content := ""
	if input["content"] != nil {
		content = jsv.String(input["content"])
	}
	if len(content) > maxFileBytes {
		return nil, errors.New("file too large")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return nil, err
	}
	rel, _ := filepath.Rel(w.abs, target)
	return jsv.Obj{"ok": true, "path": paths.ToPosix(rel), "bytes": len(content)}, nil
}

func readFile(input jsv.Obj, w workdir) (jsv.Obj, error) {
	target, err := SafeChild(w.abs, input["path"], "file.txt")
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(target)
	if err != nil {
		return nil, err
	}
	if st.Size() > maxFileBytes {
		return nil, errors.New("file too large")
	}
	b, err := os.ReadFile(target)
	if err != nil {
		return nil, err
	}
	rel, _ := filepath.Rel(w.abs, target)
	return jsv.Obj{"ok": true, "path": paths.ToPosix(rel), "content": trimOutput(string(b))}, nil
}

func listFiles(w workdir) (jsv.Obj, error) {
	files := []jsv.Obj{}
	err := filepath.WalkDir(w.abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(w.abs, p)
		files = append(files, jsv.Obj{"path": paths.ToPosix(rel), "bytes": info.Size()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return jsv.Obj{"ok": true, "files": files}, nil
}

// NormalizePoints mirrors normalizePoints in toolRuntime.cjs (finite numbers).
func NormalizePoints(points any) [][2]float64 {
	out := [][2]float64{}
	for _, p := range jsv.AsArr(points) {
		var x, y float64
		if arr := jsv.AsArr(p); arr != nil {
			if len(arr) < 2 {
				continue
			}
			x, y = jsv.Number(arr[0]), jsv.Number(arr[1])
			if arr[0] == nil || arr[1] == nil {
				x, y = math.NaN(), math.NaN()
			}
		} else if o := jsv.AsObj(p); o != nil {
			if o["x"] == nil || o["y"] == nil {
				continue
			}
			x, y = jsv.Number(o["x"]), jsv.Number(o["y"])
		} else {
			continue
		}
		if math.IsNaN(x) || math.IsNaN(y) || math.IsInf(x, 0) || math.IsInf(y, 0) {
			continue
		}
		out = append(out, [2]float64{x, y})
	}
	return out
}

func drawPathSVG(input jsv.Obj, w workdir) (jsv.Obj, error) {
	pts := NormalizePoints(jsv.Or(input["points"], input["pathPoints"]))
	width := jsv.Number(jsv.Or(input["width"], 512.0))
	height := jsv.Number(jsv.Or(input["height"], 512.0))
	if math.IsNaN(width) || width <= 0 || width > 10000 {
		width = 512
	}
	if math.IsNaN(height) || height <= 0 || height > 10000 {
		height = 512
	}
	f := jsv.FormatNumber
	var poly, circles []string
	for i, p := range pts {
		poly = append(poly, f(p[0])+","+f(p[1]))
		r, fill := "3", "#ef4444"
		if i == 0 || i == len(pts)-1 {
			r = "7"
		}
		if i == 0 {
			fill = "#22c55e"
		} else if i == len(pts)-1 {
			fill = "#3b82f6"
		}
		circles = append(circles, fmt.Sprintf(`<circle cx="%s" cy="%s" r="%s" fill="%s"/>`, f(p[0]), f(p[1]), r, fill))
	}
	svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s">
  <rect width="100%%" height="100%%" fill="#ffffff"/>
  <polyline points="%s" fill="none" stroke="#ef4444" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  %s
</svg>`, f(width), f(height), f(width), f(height), strings.Join(poly, " "), strings.Join(circles, "\n  "))
	target, err := SafeChild(w.abs, jsv.Or(input["outputPath"], "path-overlay.svg"), "path-overlay.svg")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(target, []byte(svg), 0o644); err != nil {
		return nil, err
	}
	rel, _ := filepath.Rel(w.abs, target)
	return jsv.Obj{"ok": true, "path": paths.ToPosix(rel), "points": len(pts)}, nil
}
