package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/reposandbox"
	"github.com/snakex21/benchforge/go-desktop/internal/sandbox"
)

const reportMarker = "BENCHFORGE_SANDBOX_REPORT "

// SandboxSpec is getSandboxSpec.
type SandboxSpec struct {
	Mode          any      `json:"mode"`
	Required      []string `json:"required"`
	Language      string   `json:"language"`
	Source        any      `json:"source"`
	TaskID        any      `json:"task_id"`
	EntryPoint    any      `json:"entry_point"`
	Tests         []string `json:"tests"`
	TestSetupCode any      `json:"test_setup_code"`
	TimeoutMs     float64  `json:"timeoutMs"`
}

// GetSandboxSpec parses pass_condition.sandbox (nil = not a sandbox task).
func GetSandboxSpec(b jsv.Obj) *SandboxSpec {
	var parsed jsv.Obj
	cond := jsv.Str(b["pass_condition"])
	if cond == "" {
		cond = "{}"
	}
	if json.Unmarshal([]byte(cond), &parsed) != nil || parsed == nil {
		return nil
	}
	sb := jsv.AsObj(parsed["sandbox"])
	if sb == nil {
		return nil
	}
	tests := jsv.StringList(sb["tests"])
	if len(tests) == 0 {
		return nil
	}
	timeout := jsv.Number(jsv.Or(sb["timeout_ms"], sb["timeoutMs"], 10000.0))
	if math.IsNaN(timeout) {
		timeout = 10000
	}
	return &SandboxSpec{
		Mode: jsv.Or(parsed["mode"], nil), Required: jsv.StringList(parsed["required"]),
		Language: strings.ToLower(jsv.Str(jsv.Or(sb["language"], "python"))), Source: jsv.Or(sb["source"], nil),
		TaskID: jsv.Or(sb["task_id"], nil), EntryPoint: jsv.Or(sb["entry_point"], nil), Tests: tests,
		TestSetupCode: jsv.Or(sb["test_setup_code"], nil), TimeoutMs: math.Max(1000, math.Min(120000, timeout)),
	}
}

var anyFence = regexp.MustCompile("(?s)```[a-zA-Z0-9_+-]*\\s*(.*?)```")

// ExtractCode mirrors extractCode.
func ExtractCode(response, language string) string {
	text := strings.TrimSpace(response)
	if text == "" {
		return ""
	}
	lang := strings.ToLower(language)
	pat := "[a-zA-Z0-9_+-]+"
	switch {
	case strings.Contains(lang, "python"):
		pat = "python|py"
	case strings.Contains(lang, "typescript") || lang == "ts":
		pat = "typescript|ts"
	case strings.Contains(lang, "javascript") || lang == "js" || lang == "node":
		pat = "javascript|js|node"
	}
	if m := regexp.MustCompile("(?is)```(?:" + pat + ")\\s*(.*?)```").FindStringSubmatch(text); m != nil && m[1] != "" {
		if s := strings.TrimSpace(m[1]); s != "" {
			return s
		}
	}
	if m := anyFence.FindStringSubmatch(text); m != nil && m[1] != "" {
		if s := strings.TrimSpace(m[1]); s != "" {
			return s
		}
	}
	return text
}

var tsRules = []struct {
	re   *regexp.Regexp
	repl string
}{
	{regexp.MustCompile(`(?m)^\s*import\s+type\s+[^;]+;?\s*$`), ""},
	{regexp.MustCompile(`(?ms)^\s*type\s+\w+.*?;\s*$`), ""},
	{regexp.MustCompile(`(?ms)^\s*interface\s+\w+\s*\{.*?\}\s*$`), ""},
	{regexp.MustCompile(`export\s+(function|const|let|var|class)\b`), "$1"},
	{regexp.MustCompile(`:\s*[A-Za-z_$][\w$<>,\[\]\s|&?:.]*(\s*[,)=;{])`), "$1"},
	{regexp.MustCompile(`\b(public|private|protected|readonly)\s+`), ""},
}

// StripTypeScript mirrors stripTypeScript (regex-based "typescript-lite").
func StripTypeScript(code string) string {
	for _, r := range tsRules {
		code = r.re.ReplaceAllString(code, r.repl)
	}
	return code
}

func buildPythonHarness(code string, s *SandboxSpec) string {
	return `import json
import traceback

` + code + `

` + jsv.Str(s.TestSetupCode) + `

__benchforge_tests = ` + jsv.JSONString(s.Tests) + `
__benchforge_entry_point = ` + jsv.JSONString(jsv.Str(s.EntryPoint)) + `
__benchforge_report = {"tests": [], "passed": 0, "total": len(__benchforge_tests)}

for __benchforge_index, __benchforge_test in enumerate(__benchforge_tests, start=1):
    __benchforge_item = {"index": __benchforge_index, "test": __benchforge_test, "passed": False, "error": None}
    try:
        exec(__benchforge_test, globals())
        if 'check' in globals() and callable(globals()['check']) and __benchforge_entry_point and __benchforge_entry_point in globals():
            globals()['check'](globals()[__benchforge_entry_point])
        __benchforge_item["passed"] = True
        __benchforge_report["passed"] += 1
    except Exception:
        __benchforge_item["error"] = traceback.format_exc(limit=4)
    __benchforge_report["tests"].append(__benchforge_item)

__benchforge_report["ok"] = __benchforge_report["passed"] == __benchforge_report["total"]
print(` + jsv.JSONString(reportMarker) + ` + json.dumps(__benchforge_report, ensure_ascii=False))
if not __benchforge_report["ok"]:
    raise SystemExit(1)
`
}

func buildNodeHarness(code string, s *SandboxSpec) string {
	return `const assert = (condition, message = 'assertion failed') => { if (!condition) throw new Error(message) }
global.assert = assert

` + code + `

const __benchforgeTests = ` + jsv.JSONString(s.Tests) + `
const __benchforgeReport = { tests: [], passed: 0, total: __benchforgeTests.length }
for (let i = 0; i < __benchforgeTests.length; i++) {
  const test = __benchforgeTests[i]
  const item = { index: i + 1, test, passed: false, error: null }
  try {
    const result = eval(test)
    if (typeof result === 'boolean') assert(result, 'test #' + (i + 1) + ' returned false: ' + test)
    item.passed = true
    __benchforgeReport.passed += 1
  } catch (error) {
    item.error = error && error.stack ? error.stack : String(error)
  }
  __benchforgeReport.tests.push(item)
}
__benchforgeReport.ok = __benchforgeReport.passed === __benchforgeReport.total
console.log(` + jsv.JSONString(reportMarker) + ` + JSON.stringify(__benchforgeReport))
if (!__benchforgeReport.ok) process.exit(1)
`
}

// ParseReport mirrors parseReport.
func ParseReport(stdout string, totalFallback int) jsv.Obj {
	lines := strings.Split(strings.ReplaceAll(stdout, "\r\n", "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if !strings.HasPrefix(lines[i], reportMarker) {
			continue
		}
		var parsed jsv.Obj
		if json.Unmarshal([]byte(lines[i][len(reportMarker):]), &parsed) != nil || parsed == nil {
			return nil
		}
		total := jsv.Number(jsv.Or(parsed["total"], float64(totalFallback)))
		if math.IsNaN(total) || total < 1 {
			total = 1
		}
		passed := jsv.Number(jsv.Or(parsed["passed"], 0.0))
		if math.IsNaN(passed) {
			passed = 0
		}
		passed = math.Max(0, math.Min(total, passed))
		parsed["total"], parsed["passed"], parsed["ok"] = total, passed, passed == total
		return parsed
	}
	return nil
}

func buildEvaluation(spec *SandboxSpec, result jsv.Obj, language string, report jsv.Obj) *Evaluation {
	total := jsv.Number(jsv.Or(report["total"], float64(len(spec.Tests)), 1.0))
	passed := jsv.Number(jsv.Or(report["passed"], 0.0))
	score := jsRound(passed / math.Max(1, total) * 100)
	ok := passed == total && jsv.Truthy(result["ok"])
	tests := report["tests"]
	if tests == nil {
		tests = []any{}
	}
	sb := jsv.Obj{
		"version": 2, "spec": spec, "ok": ok, "language": language, "score": score, "passed": passed, "total": total,
		"tests": tests, "workdir": result["workdir"], "tracePath": result["tracePath"],
		"stdout": jsv.Str(result["stdout"]), "stderr": jsv.Str(result["stderr"]), "timedOut": jsv.Truthy(result["timedOut"]),
		"exitCode": jsv.Coalesce(result["exitCode"]), "sandboxMode": result["sandbox"],
	}
	ev := &Evaluation{Score: score, Passed: passed, Total: total, Sandbox: sb}
	if !ok {
		detail := jsv.Str(jsv.Or(result["stderr"], result["error"], ""))
		if r := []rune(detail); len(r) > 800 {
			detail = string(r[:800])
		}
		ev.Error = fmt.Sprintf("Sandbox %s failed: %s/%s tests passed. %s", language, jsv.FormatNumber(passed), jsv.FormatNumber(total), detail)
	}
	return ev
}

// EvaluateSandbox mirrors evaluateSandbox (nil = not a sandbox benchmark).
func (r *Runner) EvaluateSandbox(ctx context.Context, b jsv.Obj, response string, opts evalOptions) *Evaluation {
	if repo := reposandbox.Evaluate(ctx, b, response, opts.repoRoots, opts.policy); repo != nil {
		return &Evaluation{Score: repo["score"], Error: jsv.Str(repo["error"]), Passed: repo["passed"], Total: repo["total"], Sandbox: repo["sandbox"]}
	}
	spec := GetSandboxSpec(b)
	if spec == nil {
		return nil
	}
	lang := spec.Language
	code := ExtractCode(response, lang)
	if strings.TrimSpace(code) == "" {
		return &Evaluation{Score: 0.0, Error: "Sandbox: no code found in model response.", Passed: 0, Total: 1,
			Sandbox: jsv.Obj{"version": 2, "spec": spec, "ok": false, "score": 0, "passed": 0, "total": 1, "tests": []any{}}}
	}
	timeout := spec.TimeoutMs
	run := func(tool, harness, label string) *Evaluation {
		result := r.Runtime.Run(ctx, jsv.Obj{"tool": tool, "input": jsv.Obj{"code": harness, "timeoutMs": timeout}}, sandbox.RunOptions{})
		report := ParseReport(jsv.Str(result["stdout"]), len(spec.Tests))
		if report == nil {
			p := 0.0
			if jsv.Truthy(result["ok"]) {
				p = float64(len(spec.Tests))
			}
			report = jsv.Obj{"passed": p, "total": float64(len(spec.Tests)), "tests": []any{}}
		}
		ev := buildEvaluation(spec, result, label, report)
		if wd := jsv.Str(result["workdir"]); wd != "" {
			_ = r.Runtime.Run(ctx, jsv.Obj{"tool": "file.write", "workdir": wd, "input": jsv.Obj{"path": "sandbox-report.json", "content": jsv.JSONIndent(ev.Sandbox)}}, sandbox.RunOptions{})
		}
		return ev
	}
	switch lang {
	case "python", "py":
		return run("python.run", buildPythonHarness(code, spec), "python")
	case "typescript", "ts":
		return run("node.run", buildNodeHarness(StripTypeScript(code), spec), "typescript-lite")
	case "javascript", "js", "node":
		return run("node.run", buildNodeHarness(code, spec), "node")
	}
	return nil
}
