// Package toolagent ports electron/toolAgent.cjs: a JSON tool-call loop
// where the model may call allow-listed tools (code runs through the
// sandbox runtime and therefore its Docker-default policy).
package toolagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"strings"

	"github.com/snakex21/benchforge/go-desktop/internal/artifacts"
	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/providers"
	"github.com/snakex21/benchforge/go-desktop/internal/sandbox"
)

var defaultAllowed = []string{"python.run", "node.run", "file.write", "file.read", "file.list", "image.draw_path_svg", "mcp.list_tools", "mcp.call"}

// Spec is parseToolSpec.
type Spec struct {
	Mode            string
	AllowedTools    []string
	DeniedTools     []string
	MCPAllowedTools []string
	MCPDeniedTools  []string
	MaxCalls        int
	TimeoutMs       float64
	Raw             jsv.Obj
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// ParseSpec returns nil when the task is not a tool task.
func ParseSpec(task, bench jsv.Obj) *Spec {
	value := jsv.Str(jsv.Or(task["pass_condition"], bench["pass_condition"], ""))
	if value == "" {
		value = "{}"
	}
	var parsed jsv.Obj
	if json.Unmarshal([]byte(value), &parsed) != nil || parsed == nil {
		return nil
	}
	if !jsv.Truthy(parsed["allowed_tools"]) && !strings.HasPrefix(jsv.Str(parsed["mode"]), "tool_") {
		return nil
	}
	allowed := jsv.StringList(parsed["allowed_tools"])
	if len(allowed) == 0 {
		allowed = append([]string(nil), defaultAllowed...)
	}
	maxCalls := jsv.Number(jsv.Or(parsed["max_calls"], 8.0))
	if math.IsNaN(maxCalls) {
		maxCalls = 8
	}
	timeout := jsv.Number(jsv.Or(parsed["timeout_ms"], 10000.0))
	if math.IsNaN(timeout) {
		timeout = 10000
	}
	return &Spec{
		Mode: jsv.Str(jsv.Or(parsed["mode"], "tool_agent")), AllowedTools: allowed,
		DeniedTools: jsv.StringList(parsed["denied_tools"]), MCPAllowedTools: jsv.StringList(parsed["mcp_allowed_tools"]),
		MCPDeniedTools: jsv.StringList(parsed["mcp_denied_tools"]),
		MaxCalls:       int(clamp(maxCalls, 1, 30)), TimeoutMs: clamp(timeout, 1000, 120000), Raw: parsed,
	}
}

// IsToolTask mirrors isToolTask.
func IsToolTask(task, bench jsv.Obj) bool { return ParseSpec(task, bench) != nil }

var fencedJSON = regexp.MustCompile("(?is)```(?:json)?\\s*(.*?)```")

// ParseJSONLike mirrors parseJsonLike.
func ParseJSONLike(text string) jsv.Obj {
	raw := strings.TrimSpace(text)
	if raw == "" {
		return nil
	}
	candidates := []string{raw}
	if m := fencedJSON.FindStringSubmatch(raw); m != nil && m[1] != "" {
		candidates = append(candidates, m[1])
	}
	for _, c := range candidates {
		var v any
		if json.Unmarshal([]byte(c), &v) == nil {
			if o, ok := v.(map[string]any); ok {
				return o
			}
			if v != nil {
				return nil
			}
		}
		start, end := strings.Index(c, "{"), strings.LastIndex(c, "}")
		if start >= 0 && end > start {
			var o map[string]any
			if json.Unmarshal([]byte(c[start:end+1]), &o) == nil {
				return o
			}
		}
	}
	return nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func protocolPrompt(task, bench jsv.Obj, spec *Spec) string {
	var descs []string
	for _, t := range sandbox.ToolDefs {
		if contains(spec.AllowedTools, jsv.Str(t["id"])) {
			descs = append(descs, fmt.Sprintf("- %s: %s", t["id"], t["description"]))
		}
	}
	denied := "- none"
	if len(spec.DeniedTools) > 0 {
		var d []string
		for _, t := range spec.DeniedTools {
			d = append(d, "- "+t)
		}
		denied = strings.Join(d, "\n")
	}
	mcpAllowed, mcpDenied := "any", "none"
	if len(spec.MCPAllowedTools) > 0 {
		mcpAllowed = strings.Join(spec.MCPAllowedTools, ", ")
	}
	if len(spec.MCPDeniedTools) > 0 {
		mcpDenied = strings.Join(spec.MCPDeniedTools, ", ")
	}
	name := jsv.Str(jsv.Or(task["name"], bench["name"]))
	prompt := jsv.Str(jsv.Or(task["prompt_template"], bench["prompt_template"]))
	return strings.TrimSpace(`
You are solving a BenchForge tool benchmark.

You may use tools. Do not pretend to use a tool. To call a tool, respond with ONLY valid JSON in this shape:
{"tool_call":{"tool":"python.run","input":{"code":"print('hello')","timeoutMs":10000}}}

After BenchForge returns TOOL_RESULT, continue. When finished, respond with ONLY valid JSON in this shape:
{"final_answer":"short final answer", "path": [[0,0],[1,0]], "artifacts": ["path.json", "path-overlay.svg"]}

Allowed tools:
` + strings.Join(descs, "\n") + `

Denied tools:
` + denied + `

MCP tool name allow/deny:
- allowed MCP tool names: ` + mcpAllowed + `
- denied MCP tool names: ` + mcpDenied + `

Important tool notes:
- python.run and node.run execute in a temporary workdir and return stdout/stderr.
- file.write writes files inside the same workdir when you pass the same workdir through tool calls automatically.
- image.draw_path_svg accepts {"points":[[x,y],...],"width":512,"height":512,"outputPath":"path-overlay.svg"}.
- For maze tasks, also create path.json with {"path": [[x,y], ...]} using file.write or python code.

Benchmark: ` + jsv.Str(bench["name"]) + `
Task: ` + name + `
Task prompt:
` + prompt + `

Tool benchmark metadata:
` + jsv.JSONIndent(spec.Raw))
}

func summarize(result jsv.Obj) jsv.Obj {
	c := jsv.Obj{}
	for k, v := range result {
		c[k] = v
	}
	for _, k := range []string{"stdout", "stderr"} {
		if s, ok := c[k].(string); ok && len([]rune(s)) > 4000 {
			c[k] = string([]rune(s)[:4000]) + "...[truncated]"
		}
	}
	return c
}

func readPathFromWorkdir(workdir string) any {
	abs := artifacts.Resolve(workdir + "/path.json")
	if abs == "" {
		return nil
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil
	}
	var parsed any
	if json.Unmarshal(b, &parsed) != nil {
		return nil
	}
	if o := jsv.AsObj(parsed); o != nil && jsv.IsArr(o["path"]) {
		return o["path"]
	}
	if jsv.IsArr(parsed) {
		return parsed
	}
	return nil
}

// intPoints mirrors toolAgent.normalizePoints (integers only).
func intPoints(points any) [][2]int {
	out := [][2]int{}
	for _, p := range sandbox.NormalizePoints(points) {
		if p[0] == math.Trunc(p[0]) && p[1] == math.Trunc(p[1]) {
			out = append(out, [2]int{int(p[0]), int(p[1])})
		}
	}
	return out
}

// VerifyGridPath mirrors verifyGridPath.
func VerifyGridPath(points any, spec jsv.Obj) jsv.Obj {
	grid := jsv.StringList(spec["grid"])
	pts := intPoints(points)
	start, end := jsv.AsArr(spec["start"]), jsv.AsArr(spec["end"])
	if len(grid) == 0 || start == nil || end == nil {
		return jsv.Obj{"passed": len(pts) > 0, "reason": "No grid metadata; path existence only", "pathPoints": pts}
	}
	res := func(ok bool, reason string) jsv.Obj {
		return jsv.Obj{"passed": ok, "reason": reason, "pathPoints": pts}
	}
	if len(pts) == 0 {
		return res(false, "No path points")
	}
	sx, sy := int(jsv.Number(at(start, 0))), int(jsv.Number(at(start, 1)))
	ex, ey := int(jsv.Number(at(end, 0))), int(jsv.Number(at(end, 1)))
	if pts[0] != [2]int{sx, sy} {
		return res(false, "Path does not start at S")
	}
	if pts[len(pts)-1] != [2]int{ex, ey} {
		return res(false, "Path does not end at E")
	}
	for i, p := range pts {
		x, y := p[0], p[1]
		if y < 0 || y >= len(grid) || x < 0 || x >= len([]rune(grid[y])) {
			return res(false, fmt.Sprintf("Point out of bounds at %d", i))
		}
		if []rune(grid[y])[x] == '#' {
			return res(false, fmt.Sprintf("Path hits wall at %d,%d", x, y))
		}
		if i > 0 {
			px, py := pts[i-1][0], pts[i-1][1]
			if abs(px-x)+abs(py-y) != 1 {
				return res(false, fmt.Sprintf("Non-adjacent step at %d", i))
			}
		}
	}
	return res(true, "Path is valid")
}

func at(a []any, i int) any {
	if i < len(a) {
		return a[i]
	}
	return nil
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// Result of a tool-agent run.
type Result struct {
	Response     string
	Thinking     string
	Score        string // "tak" / "nie"
	TokensUsed   any
	Workdir      any
	Verification jsv.Obj
}

// Run executes the agent loop.
func Run(ctx context.Context, provider providers.Provider, model, bench, task jsv.Obj, rt *sandbox.Runtime, mcpServers any, send func(string, jsv.Obj)) (*Result, error) {
	spec := ParseSpec(task, bench)
	if spec == nil {
		return nil, errors.New("Task is not configured for tool agent mode")
	}
	type turn struct{ role, content string }
	transcript := []turn{{"system", protocolPrompt(task, bench, spec)}}
	render := func() string {
		parts := make([]string, len(transcript))
		for i, t := range transcript {
			parts[i] = strings.ToUpper(t.role) + ":\n" + t.content
		}
		return strings.Join(parts, "\n\n---\n\n")
	}
	var workdir string
	var finalAnswer any
	tokens := 0.0
	last := ""
	image := ""
	if task["output_type"] == "maze" {
		image = jsv.Str(task["reference_image"])
	}
	for step := 1; step <= spec.MaxCalls+1; step++ {
		if ctx.Err() != nil {
			return nil, errors.New(providers.CancelledMessage)
		}
		mr, err := provider.SendPrompt(ctx, model, render(), image)
		if err != nil {
			return nil, err
		}
		if n := jsv.Number(mr.TokensUsed); !math.IsNaN(n) {
			tokens += n
		}
		last = mr.Response
		parsed := ParseJSONLike(last)
		call := jsv.AsObj(parsed["tool_call"])
		if call != nil && jsv.Truthy(call["tool"]) {
			tool := jsv.String(call["tool"])
			input := jsv.AsObj(call["input"])
			if input == nil {
				input = jsv.Obj{}
			}
			mcpName := ""
			if tool == "mcp.call" {
				mcpName = jsv.Str(jsv.Or(input["toolName"], input["tool_name"], input["name"], ""))
			}
			mcpBlocked := tool == "mcp.call" && ((len(spec.MCPAllowedTools) > 0 && !contains(spec.MCPAllowedTools, mcpName)) || contains(spec.MCPDeniedTools, mcpName))
			var wd any
			if workdir != "" {
				wd = workdir
			}
			if !contains(spec.AllowedTools, tool) || contains(spec.DeniedTools, tool) || mcpBlocked {
				msg := "Tool " + tool + " is not allowed"
				if mcpBlocked {
					msg = "MCP tool " + mcpName + " is not allowed"
				}
				tr := jsv.Obj{"ok": false, "error": msg, "allowedTools": spec.AllowedTools, "deniedTools": spec.DeniedTools, "mcpAllowedTools": spec.MCPAllowedTools, "mcpDeniedTools": spec.MCPDeniedTools}
				transcript = append(transcript, turn{"assistant", last}, turn{"tool", "TOOL_RESULT:\n" + jsv.JSONIndent(tr)})
				send("task:tool-call", jsv.Obj{"benchmarkId": bench["id"], "taskId": task["id"], "step": step, "tool": tool, "result": tr, "workdir": wd})
				continue
			}
			// The model controls only the tool input; interpreter paths,
			// images and Docker on/off are policy (not model) decisions.
			for _, k := range []string{"useDocker", "pythonPath", "nodePath", "pythonImage", "nodeImage"} {
				delete(input, k)
			}
			full := jsv.Obj{"timeoutMs": spec.TimeoutMs}
			for k, v := range input {
				full[k] = v
			}
			tr := rt.Run(ctx, jsv.Obj{"tool": tool, "workdir": workdir, "input": full}, sandbox.RunOptions{MCPServers: mcpServers})
			if w := jsv.Str(tr["workdir"]); w != "" {
				workdir = w
			}
			sum := summarize(tr)
			send("task:tool-call", jsv.Obj{"benchmarkId": bench["id"], "taskId": task["id"], "step": step, "tool": tool, "result": sum, "workdir": workdir})
			transcript = append(transcript, turn{"assistant", last}, turn{"tool", "TOOL_RESULT:\n" + jsv.JSONIndent(sum)})
			continue
		}
		finalAnswer = jsv.Or(parsed["final_answer"], parsed["answer"], last)
		break
	}
	finalParsed := ParseJSONLike(last)
	if finalParsed == nil {
		finalParsed = jsv.Obj{}
	}
	var pathPoints any = []any{}
	fromAnswer := jsv.Or(finalParsed["path"], jsv.AsObj(finalParsed["final"])["path"], nil)
	var fromFile any
	if workdir != "" {
		fromFile = readPathFromWorkdir(workdir)
	}
	if fromFile != nil {
		pathPoints = fromFile
	} else if jsv.Truthy(fromAnswer) {
		pathPoints = fromAnswer
	}
	var verification jsv.Obj
	if spec.Mode == "tool_maze_path" {
		verification = VerifyGridPath(pathPoints, spec.Raw)
	} else {
		verification = jsv.Obj{"passed": jsv.Truthy(finalAnswer) || last != "", "reason": "Tool agent produced final answer", "pathPoints": intPoints(pathPoints)}
	}
	if verification["passed"] == true && workdir != "" {
		var missing []string
		for _, a := range jsv.AsArr(spec.Raw["required_artifacts"]) {
			p := artifacts.Resolve(workdir + "/" + jsv.String(a))
			if p == "" {
				missing = append(missing, jsv.String(a))
				continue
			}
			if _, err := os.Stat(p); err != nil {
				missing = append(missing, jsv.String(a))
			}
		}
		if len(missing) > 0 {
			verification["passed"] = false
			verification["reason"] = "Missing required artifacts: " + strings.Join(missing, ", ")
		}
	}
	var wd any
	if workdir != "" {
		wd = workdir
	}
	response := jsv.JSONIndent(jsv.Obj{"final_answer": finalAnswer, "verification": verification, "workdir": wd, "path": verification["pathPoints"], "last_model_response": last})
	score := "nie"
	if verification["passed"] == true {
		score = "tak"
	}
	var tok any
	if tokens > 0 {
		tok = tokens
	}
	return &Result{Response: response, Thinking: render(), Score: score, TokensUsed: tok, Workdir: wd, Verification: verification}, nil
}
