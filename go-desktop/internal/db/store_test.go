package db

import (
	"database/sql"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
	"github.com/snakex21/benchforge/go-desktop/internal/secrets"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	paths.SetDataDirForTests(dir)
	t.Cleanup(func() { paths.SetDataDirForTests("") })
	s, err := Open(filepath.Join(dir, "benchforge.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// legacySchema is an early BenchForge database: models without `mode`,
// benchmarks with only the original columns, tasks/results without the later
// columns, a plaintext API key and an auto-generated "Zadanie 1" task.
const legacySchema = `
CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, provider TEXT, base_url TEXT, api_key TEXT, model_id TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE benchmarks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, benchmark_id INTEGER NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE, name TEXT NOT NULL, prompt_template TEXT NOT NULL, score_type TEXT NOT NULL CHECK(score_type IN ('numeric', 'boolean')), pass_condition TEXT, evaluation_checklist TEXT, order_index INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE results (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER REFERENCES models(id) ON DELETE CASCADE, benchmark_id INTEGER REFERENCES benchmarks(id) ON DELETE CASCADE, score TEXT NOT NULL, notes TEXT, run_at TEXT DEFAULT (datetime('now')));
CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO models (id, name, provider, base_url, api_key, model_id) VALUES (1, 'Legacy GPT', 'openai', 'https://api.openai.com/v1', 'sk-legacy-plain', 'gpt-4o');
INSERT INTO benchmarks (id, name, category) VALUES (1, 'Math', 'logic');
INSERT INTO tasks (id, benchmark_id, name, prompt_template, score_type, pass_condition, evaluation_checklist, order_index) VALUES
  (1, 1, 'Q1', '2+2?', 'boolean', 'Poprawna odpowiedź to 4', '["4"]', 0),
  (2, 1, 'Q2', '3+3?', 'numeric', NULL, NULL, 1);
INSERT INTO results (id, model_id, benchmark_id, score, notes, run_at) VALUES (1, 1, 1, '85', 'answer   with
 spaces', '2026-01-02 10:00:00');
INSERT INTO preferences (key, value) VALUES ('github_token', '"ghp_plain"'), ('ui_language', '"pl"');
`

func TestMigratesLegacyDatabase(t *testing.T) {
	dir := t.TempDir()
	paths.SetDataDirForTests(dir)
	defer paths.SetDataDirForTests("")
	path := filepath.Join(dir, "benchforge.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(legacySchema); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	defer s.Close()

	models, err := s.GetModels()
	if err != nil || len(models) != 1 {
		t.Fatalf("models %v %v", models, err)
	}
	m := models[0]
	if m["mode"] != "api" || m["active"] != true || m["api_key"] != "sk-legacy-plain" {
		t.Fatalf("migrated model %+v", m)
	}
	var stored string
	_ = s.DB().QueryRow(`SELECT api_key FROM models WHERE id = 1`).Scan(&stored)
	if !strings.HasPrefix(stored, secrets.DPAPIPrefix) {
		t.Fatalf("plaintext key must be encrypted at rest, got %q", stored)
	}
	if tok := s.Pref("github_token"); tok != "ghp_plain" {
		t.Fatalf("github token %v", tok)
	}
	b, _ := s.GetBenchmarkByID(1)
	// Benchmark inherits prompt/score settings from its first task.
	if b["prompt_template"] != "2+2?" || b["score_type"] != "boolean" || b["pass_condition"] != "Poprawna odpowiedź to 4" {
		t.Fatalf("benchmark backfill %+v", b)
	}
	if cl := b["evaluation_checklist"].([]any); len(cl) != 1 || cl[0] != "4" {
		t.Fatalf("checklist %v", b["evaluation_checklist"])
	}
	tasks, _ := s.GetTasks(1)
	if len(tasks) != 2 || tasks[0]["attempts"] != int64(1) || tasks[1]["output_type"] != "text" {
		t.Fatalf("tasks %+v", tasks)
	}
	results, _ := s.GetResults()
	if len(results) != 1 || results[0]["score"] != "85" || results[0]["attempt_number"] != int64(1) {
		t.Fatalf("results %+v", results)
	}
	// Artifacts for pre-existing results are generated on open.
	if p := jsv.Str(results[0]["artifact_path"]); p != "artifacts/runs/legacy/benchmark-1/result-1-aggregate" {
		t.Fatalf("artifact path %q", p)
	}
	if results[0]["response_preview"] != "answer with spaces" {
		t.Fatalf("preview %q", results[0]["response_preview"])
	}
	for _, f := range []string{"prompt.md", "response.txt", "result.json", "model.snapshot.json", "benchmark.snapshot.json"} {
		if _, err := os.Stat(filepath.Join(dir, "artifacts/runs/legacy/benchmark-1/result-1-aggregate", f)); err != nil {
			t.Fatalf("missing artifact %s: %v", f, err)
		}
	}
	snap, _ := os.ReadFile(filepath.Join(dir, "artifacts/runs/legacy/benchmark-1/result-1-aggregate/model.snapshot.json"))
	if strings.Contains(string(snap), "sk-legacy") || strings.Contains(string(snap), "api_key") {
		t.Fatal("model snapshot must not contain the API key")
	}
	// Every column the Electron build expects exists afterwards.
	for table, want := range map[string][]string{
		"models":           {"mode", "active", "input_price_per_1m", "pricing_updated_at"},
		"benchmarks":       {"suite_name", "prompt_template", "score_type", "evaluation_rubric", "attempts", "output_type", "reference_image"},
		"tasks":            {"attempts", "output_type", "reference_image", "expected_answer", "evaluation_rubric"},
		"results":          {"task_id", "run_session_id", "thinking_notes", "response_preview", "artifact_path", "estimated_cost_usd", "duration_ms"},
		"provider_configs": {"display_name", "icon_url", "is_custom"},
	} {
		cols, err := columns(s.db, table)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range want {
			if !cols[c] {
				t.Errorf("%s.%s missing after migration", table, c)
			}
		}
	}
	// Re-opening is idempotent.
	s.Close()
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	s2.Close()
}

func TestRemovesAutoGeneratedParentTask(t *testing.T) {
	s := openTemp(t)
	b, err := s.AddBenchmark(jsv.Obj{"name": "B", "category": "c", "prompt_template": "Same prompt"})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.AddTask(jsv.Obj{"benchmarkId": b["id"], "name": "Zadanie 1", "promptTemplate": "Same prompt", "scoreType": "numeric"})
	_, _ = s.AddTask(jsv.Obj{"benchmarkId": b["id"], "name": "Real", "promptTemplate": "Other", "scoreType": "numeric"})
	if err := removeAutoGeneratedParentTasks(s); err != nil {
		t.Fatal(err)
	}
	tasks, _ := s.GetTasks(b["id"])
	if len(tasks) != 1 || tasks[0]["name"] != "Real" {
		t.Fatalf("tasks %+v", tasks)
	}
}

func TestCRUDAndShapes(t *testing.T) {
	s := openTemp(t)
	m, err := s.AddModel(jsv.Obj{"name": "Local", "mode": "api", "provider": "lmstudio", "base_url": "http://localhost:1234/v1", "model_id": "qwen", "api_key": "", "input_price_per_1m": 1.0, "output_price_per_1m": 3.0})
	if err != nil {
		t.Fatal(err)
	}
	if m["api_key"] != nil || m["active"] != true {
		t.Fatalf("model %+v", m)
	}
	m2, _ := s.UpdateModel(m["id"], jsv.Obj{"active": false, "api_key": "sk-new", "ignored_column": "x"})
	if m2["active"] != false || m2["api_key"] != "sk-new" {
		t.Fatalf("update %+v", m2)
	}
	b, _ := s.AddBenchmark(jsv.Obj{"name": "B", "category": "logic", "scoreType": "boolean", "evaluationChecklist": []any{"a"}, "attempts": 2.0})
	if b["score_type"] != "boolean" || b["attempts"] != int64(2) {
		t.Fatalf("bench %+v", b)
	}
	b, _ = s.UpdateBenchmark(b["id"], jsv.Obj{"evaluation_rubric": []any{map[string]any{"label": "x", "weight": 1.0}}, "name": "B2"})
	if b["name"] != "B2" || len(b["evaluation_rubric"].([]any)) != 1 {
		t.Fatalf("bench update %+v", b)
	}
	t1, _ := s.AddTask(jsv.Obj{"benchmarkId": b["id"], "name": "T1", "promptTemplate": "p1", "scoreType": "boolean", "orderIndex": 1.0})
	t2, _ := s.AddTask(jsv.Obj{"benchmarkId": b["id"], "name": "T2", "promptTemplate": "p2", "scoreType": "boolean", "orderIndex": 0.0})
	ordered, _ := s.ReorderTasks(b["id"], []any{t1["id"], t2["id"]})
	if ordered[0]["name"] != "T1" {
		t.Fatalf("reorder %+v", ordered)
	}
	sess, err := s.CreateRunSession(jsv.Obj{"model_id": m["id"], "benchmark_ids": []any{b["id"]}})
	if err != nil {
		t.Fatal(err)
	}
	r, err := s.AddResult(jsv.Obj{"model_id": m["id"], "benchmark_id": b["id"], "task_id": t1["id"], "run_session_id": sess["id"], "score": "tak", "notes": "ok", "input_tokens": 1000.0, "output_tokens": 2000.0})
	if err != nil {
		t.Fatal(err)
	}
	if r["estimated_cost_usd"] != 0.007 {
		t.Fatalf("cost %v", r["estimated_cost_usd"])
	}
	if !strings.Contains(jsv.Str(r["artifact_path"]), "session-") {
		t.Fatalf("artifact path %v", r["artifact_path"])
	}
	sess, _ = s.UpdateRunSession(sess["id"], jsv.Obj{"completed_task_ids": []any{t1["id"]}})
	if len(sess["completed_task_ids"].([]any)) != 1 {
		t.Fatalf("session %+v", sess)
	}
	active, _ := s.GetActiveRunSession()
	if active == nil || active["id"] != sess["id"] {
		t.Fatal("active session")
	}
	_ = s.InterruptActiveRunSessions()
	active, _ = s.GetActiveRunSession()
	if active["status"] != "interrupted" {
		t.Fatal("interrupted")
	}
	latest, _ := s.GetLatestTaskResult(m["id"], b["id"], t1["id"], "")
	if latest == nil || latest["id"] != r["id"] {
		t.Fatal("latest task result")
	}
	// Deleting a task removes its results.
	if _, err := s.DeleteTask(t1["id"]); err != nil {
		t.Fatal(err)
	}
	res, _ := s.GetResults()
	if len(res) != 0 {
		t.Fatalf("results after task delete %d", len(res))
	}
	// Preferences round-trip JSON values.
	_ = s.SavePreference("panel", map[string]any{"open": true})
	if v := s.Pref("panel").(map[string]any); v["open"] != true {
		t.Fatal("pref")
	}
	_ = s.SavePreference("judge_model_id", m["id"])
	_, _ = s.DeleteModel(m["id"])
	if s.Pref("judge_model_id") != nil {
		t.Fatal("judge preference must be cleared")
	}
	// Provider configs: encrypted at rest, decrypted on read.
	pc, _ := s.SaveProviderConfig("openai", jsv.Obj{"api_key": "sk-prov", "is_custom": true})
	if pc["api_key"] != "sk-prov" || pc["is_custom"] != true {
		t.Fatalf("provider config %+v", pc)
	}
	var stored string
	_ = s.DB().QueryRow(`SELECT api_key FROM provider_configs WHERE provider='openai'`).Scan(&stored)
	if strings.Contains(stored, "sk-prov") {
		t.Fatal("provider key stored in plaintext")
	}
}

func TestEffectiveModelInheritsProviderKey(t *testing.T) {
	s := openTemp(t)
	m, _ := s.AddModel(jsv.Obj{"name": "GPT", "mode": "api", "provider": "openai", "model_id": "gpt"})
	_, _ = s.SaveProviderConfig("openai", jsv.Obj{"api_key": "sk-shared", "base_url": "https://api.openai.com/v1"})
	eff, _ := s.GetEffectiveModelConfig(m["id"])
	if eff["api_key"] != "sk-shared" {
		t.Fatalf("effective %+v", eff)
	}
}

func TestExportImportRoundTrip(t *testing.T) {
	s := openTemp(t)
	m, _ := s.AddModel(jsv.Obj{"name": "M", "mode": "manual", "api_key": "secret"})
	b, _ := s.AddBenchmark(jsv.Obj{"name": "B", "category": "c"})
	_, _ = s.AddTask(jsv.Obj{"benchmarkId": b["id"], "name": "T", "promptTemplate": "p", "scoreType": "numeric"})
	_, _ = s.AddResult(jsv.Obj{"model_id": m["id"], "benchmark_id": b["id"], "score": 50.0, "notes": "n"})
	_, _ = s.AddRun(jsv.Obj{"name": "run"})
	exported, err := s.GetAllData()
	if err != nil {
		t.Fatal(err)
	}
	if exported["models"].([]Obj)[0]["api_key"] != nil {
		t.Fatal("export must strip api keys")
	}
	// Simulate the UI: JSON round trip.
	var payload map[string]any
	if err := jsonUnmarshal(jsv.JSONString(exported), &payload); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClearAllData(); err != nil {
		t.Fatal(err)
	}
	imported, err := s.ReplaceAllData(payload)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"models", "benchmarks", "tasks", "results", "runs"} {
		if len(imported[k].([]Obj)) != len(exported[k].([]Obj)) {
			t.Errorf("%s count mismatch", k)
		}
	}
	if imported["results"].([]Obj)[0]["score"] != "50" {
		t.Fatalf("score %v", imported["results"].([]Obj)[0]["score"])
	}
	// Malformed payload is rejected without touching data.
	if _, err := s.ReplaceAllData(map[string]any{"models": []any{"oops"}}); err == nil {
		t.Fatal("expected validation error")
	}
	after, _ := s.GetBenchmarks()
	if len(after) != 1 {
		t.Fatal("failed import must not wipe data")
	}
}

func TestBindRejectsObjects(t *testing.T) {
	s := openTemp(t)
	if _, err := s.UpdateModel(1, jsv.Obj{"name": map[string]any{"x": 1}}); err == nil {
		t.Fatal("objects must not be bound into SQL")
	}
}

// TestOpensElectronDatabaseCopy runs against a copy of a real database
// written by the Electron build when BENCHFORGE_TEST_ELECTRON_DB points to
// one (the file is copied; the original is never opened for writing).
func TestOpensElectronDatabaseCopy(t *testing.T) {
	src := os.Getenv("BENCHFORGE_TEST_ELECTRON_DB")
	if src == "" {
		t.Skip("BENCHFORGE_TEST_ELECTRON_DB not set")
	}
	dir := t.TempDir()
	paths.SetDataDirForTests(dir)
	defer paths.SetDataDirForTests("")
	dst := filepath.Join(dir, "benchforge.db")
	for _, suffix := range []string{"", "-wal"} {
		in, err := os.Open(src + suffix)
		if err != nil {
			if suffix != "" {
				continue
			}
			t.Fatal(err)
		}
		out, _ := os.Create(dst + suffix)
		_, _ = io.Copy(out, in)
		in.Close()
		out.Close()
	}
	s, err := Open(dst)
	if err != nil {
		t.Fatalf("open electron db copy: %v", err)
	}
	defer s.Close()
	data, err := s.GetAllData()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("electron db: %d models, %d benchmarks, %d tasks, %d results, %d runs",
		len(data["models"].([]Obj)), len(data["benchmarks"].([]Obj)), len(data["tasks"].([]Obj)), len(data["results"].([]Obj)), len(data["runs"].([]Obj)))
	models, _ := s.GetModels()
	withKey := 0
	for _, m := range models {
		if m["api_key"] != nil {
			withKey++
		}
	}
	pcs, _ := s.GetAllProviderConfigs()
	for _, pc := range pcs {
		if pc["api_key"] != nil {
			withKey++
		}
	}
	t.Logf("decrypted secrets: %d (values not logged)", withKey)
	_ = base64.StdEncoding
}
