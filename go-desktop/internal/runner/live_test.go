package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/db"
	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
	"github.com/snakex21/benchforge/go-desktop/internal/providers"
	"github.com/snakex21/benchforge/go-desktop/internal/sandbox"
)

// TestLiveProvider runs a small benchmark against a real OpenAI-compatible
// endpoint through the real runner, DB and provider code. It is skipped
// unless BF_LIVE_BASE_URL and BF_LIVE_MODEL are set; the API key is read
// from BF_LIVE_KEY (never logged). BF_LIVE_DATA keeps the data dir so the
// results can be opened in the app; BF_LIVE_OUT receives a JSON summary.
func TestLiveProvider(t *testing.T) {
	base, model := os.Getenv("BF_LIVE_BASE_URL"), os.Getenv("BF_LIVE_MODEL")
	if base == "" || model == "" {
		t.Skip("set BF_LIVE_BASE_URL and BF_LIVE_MODEL to run against a real provider")
	}
	dir := os.Getenv("BF_LIVE_DATA")
	if dir == "" {
		dir = t.TempDir()
	}
	paths.SetDataDirForTests(dir)
	defer paths.SetDataDirForTests("")
	store, err := db.Open(filepath.Join(dir, "benchforge.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	price := func(k string) any {
		if f, err := strconv.ParseFloat(os.Getenv(k), 64); err == nil {
			return f
		}
		return nil
	}
	name := os.Getenv("BF_LIVE_NAME")
	if name == "" {
		name = model
	}
	m, err := store.AddModel(jsv.Obj{"name": name, "mode": "api", "provider": "openai", "base_url": base, "api_key": os.Getenv("BF_LIVE_KEY"), "model_id": model,
		"input_price_per_1m": price("BF_LIVE_IN_PRICE"), "output_price_per_1m": price("BF_LIVE_OUT_PRICE")})
	if err != nil {
		t.Fatal(err)
	}
	full, _ := store.GetModelByID(m["id"])
	api := &providers.API{}
	if ok, msg := api.TestConnection(context.Background(), full); !ok {
		t.Fatalf("test connection: %s", msg)
	}
	b, _ := store.AddBenchmark(jsv.Obj{"name": "Live smoke", "category": "logic", "score_type": "boolean", "prompt_template": "Answer briefly."})
	tasks := [][2]string{
		{"What is 17 * 23? Reply with the number only.", "Poprawna odpowiedź to 391"},
		{"What is the capital of Australia? Reply with one word.", "Poprawna odpowiedź to canberra"},
		{"Name the chemical symbol for gold. Reply with the symbol only.", "Poprawna odpowiedź to au"},
	}
	for i, tk := range tasks {
		if _, err := store.AddTask(jsv.Obj{"benchmarkId": b["id"], "name": "T" + strconv.Itoa(i+1), "promptTemplate": tk[0], "scoreType": "boolean", "passCondition": tk[1], "orderIndex": float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	r := &Runner{Store: store, Policy: func() sandbox.Policy { return sandbox.PolicyFromPrefs(nil, nil) }}
	r.Runtime = sandbox.New(r.Policy)
	var chunks, thinking int
	start := time.Now()
	out := r.RunStreaming(context.Background(), m["id"], b["id"], func(ev string, p Obj) {
		switch ev {
		case "task:chunk":
			chunks++
		case "task:thinking-chunk":
			thinking++
		}
	}, nil, nil)
	if out["error"] != nil {
		t.Fatalf("run error: %v", out["error"])
	}
	results, _ := store.GetResults()
	var in, outTok float64
	var rows []Obj
	for _, res := range results {
		if res["task_id"] == nil {
			continue
		}
		in += jsv.Number(jsv.Or(res["input_tokens"], 0.0))
		outTok += jsv.Number(jsv.Or(res["output_tokens"], 0.0))
		rows = append(rows, Obj{"task": res["task_id"], "score": res["score"], "response": res["notes"], "in": res["input_tokens"], "out": res["output_tokens"], "ms": res["duration_ms"]})
	}
	ip, _ := price("BF_LIVE_IN_PRICE").(float64)
	op, _ := price("BF_LIVE_OUT_PRICE").(float64)
	cost := (in*ip + outTok*op) / 1e6
	summary := Obj{"model": model, "summary": out["summary"], "tasks": rows, "input_tokens": in, "output_tokens": outTok, "cost_usd": cost,
		"stream_chunks": chunks, "thinking_chunks": thinking, "wall_ms": time.Since(start).Milliseconds()}
	js, _ := json.MarshalIndent(summary, "", "  ")
	t.Logf("%s", js)
	if p := os.Getenv("BF_LIVE_OUT"); p != "" {
		_ = os.WriteFile(p, js, 0o644)
	}
	if chunks == 0 || len(rows) != len(tasks) {
		t.Fatalf("expected streamed answers for %d tasks", len(tasks))
	}
	// manual single prompt (model:send-prompt path, non-streaming)
	if res, err := api.SendPrompt(context.Background(), full, "Reply with the word OK.", ""); err != nil || res.Response == "" {
		t.Fatalf("send-prompt: %v %+v", err, res)
	}
}
