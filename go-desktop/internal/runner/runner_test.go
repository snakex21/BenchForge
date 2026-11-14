package runner

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/snakex21/benchforge/go-desktop/internal/db"
	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
	"github.com/snakex21/benchforge/go-desktop/internal/proc"
	"github.com/snakex21/benchforge/go-desktop/internal/providers"
	"github.com/snakex21/benchforge/go-desktop/internal/reposandbox"
	"github.com/snakex21/benchforge/go-desktop/internal/sandbox"
)

// ---- scoring: port of electron/runner.cjs behaviour (golden cases) ----

func TestEvaluateBoolean(t *testing.T) {
	b := jsv.Obj{"pass_condition": "Poprawna odpowiedź to Paryż.", "evaluation_checklist": []any{}}
	cases := map[string]string{
		"Tak, to prawda":      "tak",
		"NIE":                 "nie",
		"Stolicą jest Paryż":  "tak",
		"Berlin":              "nie",
		"tak i nie":           "tak", // legacy: first match wins (documented quirk)
		"takeaway is nothing": "nie",
	}
	for resp, want := range cases {
		if got := EvaluateBoolean(b, resp); got != want {
			t.Errorf("%q => %q want %q", resp, got, want)
		}
	}
	if got := EvaluateBoolean(jsv.Obj{}, "maybe"); got != "" {
		t.Errorf("no expected answers => %q", got)
	}
}

func TestEvaluateNumeric(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{{"Score: 85%", 85, true}, {"100", 100, true}, {"wynik 7/10", 7, true}, {"brak", 0, false}, {"1234", 0, false}}
	for _, c := range cases {
		got, ok := EvaluateNumeric(c.in)
		if ok != c.ok || got != c.want {
			t.Errorf("%q => %v,%v", c.in, got, ok)
		}
	}
}

func TestCodePresence(t *testing.T) {
	cond := func(req ...any) jsv.Obj {
		if req == nil {
			req = []any{}
		}
		return jsv.Obj{"pass_condition": jsv.JSONString(map[string]any{"mode": "code_presence", "required": req})}
	}
	cases := []struct {
		b    jsv.Obj
		resp string
		want float64
	}{
		{cond("greet"), "def greet(name):\n  return name", 100},
		{cond("greet"), "def greet0(name): pass", 0}, // prefix-only declaration
		{cond("reverse"), "s.reverse()", 100},        // method access
		{cond("def first_element"), "def first_element(x):", 100},
		{cond("def first_element"), "def first_element0(x):", 0},
		{cond("% 2"), "return n % 2 == 0", 100},
		{cond("seen"), "widziane = set()", 100},
		{cond(), "anything", 0},
	}
	for i, c := range cases {
		ev := EvaluateCodePresence(c.b, c.resp)
		if ev == nil || jsv.Number(ev.Score) != c.want {
			t.Errorf("case %d: %+v", i, ev)
		}
	}
	if EvaluateCodePresence(jsv.Obj{"pass_condition": "not json"}, "x") != nil {
		t.Error("non code_presence must return nil")
	}
}

func TestNormalizeAndAggregate(t *testing.T) {
	num := jsv.Obj{"score_type": "numeric"}
	if got := NormalizeBenchmarkScore(num, 90.0, 2, 3); got != 60.0 {
		t.Errorf("attempt penalty: %v", got)
	}
	if got := NormalizeBenchmarkScore(num, 150.0, 1, 1); got != 100.0 {
		t.Errorf("clamp: %v", got)
	}
	if got := NormalizeBenchmarkScore(jsv.Obj{"score_type": "boolean"}, "tak", 3, 3); got != "tak" {
		t.Errorf("boolean passthrough: %v", got)
	}
	if got := AggregateBenchmarkScore(num, []any{"50", 100.0, nil, "x"}); got != 75.0 {
		t.Errorf("avg: %v", got)
	}
	if got := AggregateBenchmarkScore(num, []any{1.0, 2.0, 2.0}); got != 1.67 {
		t.Errorf("toFixed(2): %v", got)
	}
	if got := AggregateBenchmarkScore(jsv.Obj{"score_type": "boolean"}, []any{"tak", "TAK"}); got != "tak" {
		t.Errorf("bool all: %v", got)
	}
	if got := AggregateBenchmarkScore(jsv.Obj{"score_type": "boolean"}, []any{"tak", "nie"}); got != "nie" {
		t.Errorf("bool any fail: %v", got)
	}
	if AggregateBenchmarkScore(num, []any{nil}) != nil {
		t.Error("no scores => nil")
	}
}

func TestNormalizeProvidedScore(t *testing.T) {
	if NormalizeProvidedScore("PASS", "boolean") != "tak" || NormalizeProvidedScore("0", "boolean") != "nie" || NormalizeProvidedScore("maybe", "boolean") != nil {
		t.Error("boolean mapping")
	}
	if NormalizeProvidedScore("87,5 pkt", "numeric") != 87.5 || NormalizeProvidedScore("-4", "numeric") != 0.0 || NormalizeProvidedScore("", "numeric") != nil {
		t.Error("numeric mapping")
	}
}

func TestStaleLegacyTask(t *testing.T) {
	b := jsv.Obj{"prompt_template": "Same", "pass_condition": "c"}
	stale := jsv.Obj{"name": "Zadanie 1", "prompt_template": " Same ", "pass_condition": "c"}
	if !IsStaleLegacyTask(stale, b, 2) || IsStaleLegacyTask(stale, b, 1) {
		t.Error("stale detection")
	}
	if IsStaleLegacyTask(jsv.Obj{"name": "Real", "prompt_template": "Same"}, b, 2) {
		t.Error("named task is not stale")
	}
}

func TestSandboxHelpers(t *testing.T) {
	code := ExtractCode("text\n```python\ndef f():\n  return 1\n```\nmore", "python")
	if code != "def f():\n  return 1" {
		t.Fatalf("extract %q", code)
	}
	if ExtractCode("```js\nx()\n```", "python") != "x()" {
		t.Fatal("fallback fence")
	}
	ts := StripTypeScript("export function add(a: number, b: number): number { return a + b }\ninterface X {\n a: string\n}\n")
	if strings.Contains(ts, "interface") || strings.Contains(ts, "export") || strings.Contains(ts, ": number") {
		t.Fatalf("strip %q", ts)
	}
	r := ParseReport("noise\nBENCHFORGE_SANDBOX_REPORT {\"passed\":5,\"total\":3}\n", 3)
	if r["passed"] != 3.0 || r["ok"] != true {
		t.Fatalf("report clamp %+v", r)
	}
	spec := GetSandboxSpec(jsv.Obj{"pass_condition": `{"mode":"code","sandbox":{"language":"Python","tests":["assert f()==1"],"timeout_ms":999999}}`})
	if spec == nil || spec.Language != "python" || spec.TimeoutMs != 120000 {
		t.Fatalf("spec %+v", spec)
	}
}

// ---- model runner safety: model output reaches only the sandbox ----

func TestSandboxEvaluationUsesDockerPolicy(t *testing.T) {
	paths.SetDataDirForTests(t.TempDir())
	defer paths.SetDataDirForTests("")
	var mu sync.Mutex
	var names []string
	rt := &sandbox.Runtime{
		Policy: func() sandbox.Policy { return sandbox.PolicyFromPrefs(nil, nil) },
		Exec: func(ctx context.Context, name string, args []string, o proc.Options) proc.Result {
			mu.Lock()
			names = append(names, name+" "+strings.Join(args, " "))
			mu.Unlock()
			code := 0
			return proc.Result{OK: true, ExitCode: &code, Stdout: "BENCHFORGE_SANDBOX_REPORT {\"passed\":1,\"total\":1,\"tests\":[]}"}
		},
		DockerAvailable: func(context.Context) bool { return true },
	}
	r := &Runner{Runtime: rt, Policy: rt.Policy}
	b := jsv.Obj{"pass_condition": `{"sandbox":{"language":"python","tests":["assert add(1,2)==3"]}}`}
	ev := r.EvaluateSandbox(context.Background(), b, "```python\ndef add(a,b): return a+b\n```", evalOptions{policy: rt.Policy()})
	if ev == nil || jsv.Number(ev.Score) != 100 {
		t.Fatalf("eval %+v", ev)
	}
	if len(names) != 1 || !strings.HasPrefix(names[0], "docker run") || !strings.Contains(names[0], "--network none") {
		t.Fatalf("model code must run only inside Docker, got %v", names)
	}
}

func TestRepoSandboxRefusedWithoutHostOptIn(t *testing.T) {
	paths.SetDataDirForTests(t.TempDir())
	defer paths.SetDataDirForTests("")
	oldAvail := reposandbox.DockerAvailable
	reposandbox.DockerAvailable = func(context.Context) bool { return false }
	defer func() { reposandbox.DockerAvailable = oldAvail }()
	rt := &sandbox.Runtime{Policy: func() sandbox.Policy { return sandbox.PolicyFromPrefs(nil, nil) }}
	r := &Runner{Runtime: rt, Policy: rt.Policy}
	b := jsv.Obj{"pass_condition": `{"mode":"repo_patch","repo":"me/repo"}`}
	roots := []any{map[string]any{"repo": "me/repo", "path": t.TempDir(), "testCommand": "echo pwned > C:\\pwned.txt"}}
	ev := r.EvaluateSandbox(context.Background(), b, "diff --git a/x b/x\n--- a/x\n+++ b/x\n", evalOptions{repoRoots: roots, policy: rt.Policy()})
	if ev == nil || jsv.Number(ev.Score) != 0 || !strings.Contains(ev.Error, "Docker is not available") {
		t.Fatalf("expected refusal, got %+v", ev)
	}
}

// ---- end-to-end streaming run against a fake provider and a real DB ----

type fakeProvider struct{ answer string }

func (f fakeProvider) SendPrompt(ctx context.Context, m jsv.Obj, p, img string) (providers.Result, error) {
	return providers.Result{Response: f.answer, TokensUsed: int64(10)}, nil
}
func (f fakeProvider) StreamPrompt(ctx context.Context, m jsv.Obj, p, img string, h providers.Handlers) (providers.Result, error) {
	h.OnThinkingChunk("hmm ")
	for _, w := range strings.SplitAfter(f.answer, " ") {
		h.OnChunk(w)
	}
	return providers.Result{Response: f.answer, TokensUsed: int64(12), InputTokens: int64(4), OutputTokens: int64(8)}, nil
}
func (fakeProvider) TestConnection(context.Context, jsv.Obj) (bool, string) { return true, "" }

func TestRunStreamingEndToEnd(t *testing.T) {
	dir := t.TempDir()
	paths.SetDataDirForTests(dir)
	defer paths.SetDataDirForTests("")
	store, err := db.Open(filepath.Join(dir, "benchforge.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	m, _ := store.AddModel(jsv.Obj{"name": "Fake", "mode": "api", "provider": "lmstudio", "base_url": "http://127.0.0.1:1/v1", "model_id": "fake"})
	b, _ := store.AddBenchmark(jsv.Obj{"name": "B", "category": "logic", "score_type": "numeric", "prompt_template": "p"})
	t1, _ := store.AddTask(jsv.Obj{"benchmarkId": b["id"], "name": "T1", "promptTemplate": "rate", "scoreType": "numeric"})
	_, _ = store.AddTask(jsv.Obj{"benchmarkId": b["id"], "name": "T2", "promptTemplate": "rate2", "scoreType": "numeric", "orderIndex": 1.0})
	r := &Runner{Store: store, Policy: func() sandbox.Policy { return sandbox.PolicyFromPrefs(nil, nil) },
		Provider: func(string) (providers.Provider, error) { return fakeProvider{"Ocena: 80 punktów"}, nil }}
	r.Runtime = sandbox.New(r.Policy)
	var events []string
	var done jsv.Obj
	out := r.RunStreaming(context.Background(), m["id"], b["id"], func(ev string, p Obj) {
		events = append(events, ev)
		if ev == "benchmark:done" {
			done = p
		}
	}, nil, nil)
	if out["error"] != nil || done == nil {
		t.Fatalf("run failed: %+v", out)
	}
	if done["summary"].(Obj)["avgScore"] != 80.0 || done["summary"].(Obj)["completed"] != 2 {
		t.Fatalf("summary %+v", done["summary"])
	}
	joined := strings.Join(events, ",")
	for _, want := range []string{"task:thinking-chunk", "task:chunk", "task:done", "benchmark:done"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing event %s in %s", want, joined)
		}
	}
	results, _ := store.GetResults()
	if len(results) != 3 { // 2 task results + aggregate
		t.Fatalf("results %d", len(results))
	}
	sess, _ := store.GetActiveRunSession()
	if sess != nil {
		t.Fatalf("session should be finished, got %+v", sess)
	}
	// Resuming a finished session's task list restores results instead of re-running.
	latest, _ := store.GetLatestTaskResult(m["id"], b["id"], t1["id"], "")
	if latest == nil || latest["score"] != "80" {
		t.Fatalf("latest %+v", latest)
	}
}

func TestRunStreamingCancellation(t *testing.T) {
	dir := t.TempDir()
	paths.SetDataDirForTests(dir)
	defer paths.SetDataDirForTests("")
	store, _ := db.Open(filepath.Join(dir, "benchforge.db"))
	defer store.Close()
	m, _ := store.AddModel(jsv.Obj{"name": "Fake", "mode": "api", "base_url": "http://x/v1", "model_id": "f"})
	b, _ := store.AddBenchmark(jsv.Obj{"name": "B", "category": "c", "prompt_template": "p"})
	r := &Runner{Store: store, Policy: func() sandbox.Policy { return sandbox.Policy{UseDocker: true} },
		Provider: func(string) (providers.Provider, error) { return fakeProvider{"50"}, nil }}
	r.Runtime = sandbox.New(r.Policy)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var events []string
	out := r.RunStreaming(ctx, m["id"], b["id"], func(ev string, p Obj) { events = append(events, ev) }, nil, nil)
	if out["error"] != providers.CancelledMessage || strings.Join(events, ",") != "benchmark:aborted" {
		t.Fatalf("cancel: %+v %v", out, events)
	}
}
