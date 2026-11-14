// Package db is the Go port of electron/database.cjs on modernc.org/sqlite
// (pure Go, no CGO). Rows are returned as JSON-ready maps with exactly the
// keys the React UI received from the Electron IPC handlers.
package db

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"

	"github.com/snakex21/benchforge/go-desktop/internal/artifacts"
	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/secrets"
)

type Obj = jsv.Obj

// Store wraps one SQLite connection (like better-sqlite3: single connection,
// serialised access), which keeps PRAGMA foreign_keys per-connection state
// and transactions simple.
type Store struct {
	db   *sql.DB
	Path string
	// WriteArtifacts can be disabled in tests.
	WriteArtifacts bool
}

// Open opens (or creates) the database and runs the schema migrations.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	dsn := "file:" + filepath.ToSlash(path) + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	sqldb, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	sqldb.SetMaxOpenConns(1)
	sqldb.SetMaxIdleConns(1)
	if err := sqldb.Ping(); err != nil {
		sqldb.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	s := &Store{db: sqldb, Path: path, WriteArtifacts: true}
	if err := s.migrate(); err != nil {
		sqldb.Close()
		return nil, err
	}
	if _, err := s.EnsureResultArtifacts(); err != nil {
		log.Printf("[artifacts] ensure: %v", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// DB exposes the handle for tests.
func (s *Store) DB() *sql.DB { return s.db }

// ---------- generic helpers ----------

func scanRows(rows *sql.Rows) ([]Obj, error) {
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []Obj{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := Obj{}
		for i, c := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			row[c] = v
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *Store) all(q string, args ...any) ([]Obj, error) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	return scanRows(rows)
}

func (s *Store) one(q string, args ...any) (Obj, error) {
	rows, err := s.all(q, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

func changes(res sql.Result) Obj {
	n, _ := res.RowsAffected()
	id, _ := res.LastInsertId()
	return Obj{"changes": n, "lastInsertRowid": id}
}

func bindAll(values ...any) ([]any, error) {
	out := make([]any, len(values))
	for i, v := range values {
		b, err := jsv.Bind(v)
		if err != nil {
			return nil, err
		}
		out[i] = b
	}
	return out, nil
}

func (s *Store) exec(q string, values ...any) (sql.Result, error) {
	args, err := bindAll(values...)
	if err != nil {
		return nil, err
	}
	return s.db.Exec(q, args...)
}

func nullIfFalsy(v any) any {
	if jsv.Truthy(v) {
		return v
	}
	return nil
}

func jsonParseArray(v any) any {
	s, _ := v.(string)
	if s == "" {
		return []any{}
	}
	var out any
	if err := jsonUnmarshal(s, &out); err != nil {
		return []any{}
	}
	return out
}

func safeJSONArray(v any) []any {
	s, _ := v.(string)
	if s == "" {
		s = "[]"
	}
	var out any
	if err := jsonUnmarshal(s, &out); err != nil {
		return []any{}
	}
	if a, ok := out.([]any); ok {
		return a
	}
	return []any{}
}

func boolish(v any) bool { return jsv.Truthy(v) }

func coalesceInt(v any, def int64) any {
	if v == nil {
		return def
	}
	return v
}

// updateQuery is buildUpdateQuery: fieldMap maps payload keys to columns.
func updateQuery(table string, fieldMap [][2]string, id any, data Obj, extraSet string) (string, []any, error) {
	seen := map[string]int{}
	cols := []string{}
	vals := []any{}
	for _, kv := range fieldMap {
		key, col := kv[0], kv[1]
		if !jsv.Has(data, key) {
			continue
		}
		b, err := jsv.Bind(data[key])
		if err != nil {
			return "", nil, fmt.Errorf("%s.%s: %w", table, key, err)
		}
		if i, ok := seen[col]; ok {
			vals[i] = b
			continue
		}
		seen[col] = len(cols)
		cols = append(cols, col)
		vals = append(vals, b)
	}
	if len(cols) == 0 {
		return "", nil, nil
	}
	sets := make([]string, len(cols))
	for i, c := range cols {
		sets[i] = c + " = ?"
	}
	set := strings.Join(sets, ", ")
	if extraSet != "" {
		set += ", " + extraSet
	}
	idb, err := jsv.Bind(id)
	if err != nil {
		return "", nil, err
	}
	return `UPDATE ` + table + ` SET ` + set + ` WHERE id = ?`, append(vals, idb), nil
}

// ---------- secrets ----------

func decryptOrNil(v any) any {
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	plain, ok := secrets.Decrypt(s)
	if !ok || plain == "" {
		return nil
	}
	return plain
}

func encryptOrNil(v any) (any, error) {
	if !jsv.Truthy(v) {
		return nil, nil
	}
	enc, err := secrets.Encrypt(jsv.String(v))
	if err != nil {
		return nil, fmt.Errorf("encrypt secret: %w", err)
	}
	if enc == "" {
		return nil, nil
	}
	return enc, nil
}

var secretPreferenceKeys = map[string]bool{"github_token": true}

// migrateStoredSecrets encrypts legacy plaintext / insecure-fallback values.
// Values protected by Electron safeStorage ("bfsec:") are left untouched so
// that the Electron build can still read the same database.
func (s *Store) migrateStoredSecrets() error {
	needs := func(v string) bool {
		return v != "" && !secrets.IsEncrypted(v)
	}
	rows, err := s.all(`SELECT id, api_key FROM models WHERE api_key IS NOT NULL AND api_key != ''`)
	if err != nil {
		return err
	}
	for _, r := range rows {
		v, _ := r["api_key"].(string)
		if !needs(v) {
			continue
		}
		if enc, changed := secrets.MigrateValue(v); changed {
			if _, err := s.db.Exec(`UPDATE models SET api_key = ? WHERE id = ?`, enc, r["id"]); err != nil {
				return err
			}
		}
	}
	prefs, err := s.all(`SELECT key, value FROM preferences WHERE key = 'github_token'`)
	if err != nil {
		return err
	}
	for _, r := range prefs {
		parsed := parsePreferenceValue(r["value"])
		v, _ := parsed.(string)
		if !needs(v) {
			continue
		}
		if enc, changed := secrets.MigrateValue(v); changed {
			if _, err := s.db.Exec(`UPDATE preferences SET value = ? WHERE key = ?`, jsv.JSONString(enc), r["key"]); err != nil {
				return err
			}
		}
	}
	return nil
}

// ---------- row mappers (identical keys to the JS mappers) ----------

func normalizeScore(v any) string {
	if v == nil {
		return ""
	}
	return jsv.String(v)
}

func mapModel(r Obj) Obj {
	active := true
	if r["active"] != nil {
		active = boolish(r["active"])
	}
	return Obj{
		"id": r["id"], "name": r["name"], "mode": r["mode"], "provider": r["provider"], "base_url": r["base_url"],
		"api_key": decryptOrNil(r["api_key"]), "model_id": r["model_id"], "active": active,
		"input_price_per_1m": r["input_price_per_1m"], "output_price_per_1m": r["output_price_per_1m"],
		"pricing_source": r["pricing_source"], "pricing_model_id": r["pricing_model_id"], "pricing_updated_at": r["pricing_updated_at"],
		"created_at": r["created_at"],
	}
}

func mapBenchmark(r Obj) Obj {
	return Obj{
		"id": r["id"], "name": r["name"], "category": r["category"], "description": r["description"],
		"suite_name":           nullIfFalsy(r["suite_name"]),
		"prompt_template":      jsv.Or(r["prompt_template"], ""),
		"score_type":           jsv.Or(r["score_type"], "numeric"),
		"expected_answer":      nullIfFalsy(r["expected_answer"]),
		"pass_condition":       nullIfFalsy(r["pass_condition"]),
		"evaluation_checklist": jsonParseArray(r["evaluation_checklist"]),
		"evaluation_rubric":    jsonParseArray(r["evaluation_rubric"]),
		"attempts":             coalesceInt(r["attempts"], 1),
		"output_type":          jsv.Or(r["output_type"], "text"),
		"reference_image":      nullIfFalsy(r["reference_image"]),
		"created_at":           r["created_at"],
	}
}

func mapTask(r Obj) Obj {
	return Obj{
		"id": r["id"], "benchmark_id": r["benchmark_id"], "name": r["name"], "prompt_template": r["prompt_template"],
		"score_type": r["score_type"], "expected_answer": nullIfFalsy(r["expected_answer"]), "pass_condition": r["pass_condition"],
		"evaluation_checklist": jsonParseArray(r["evaluation_checklist"]),
		"evaluation_rubric":    jsonParseArray(r["evaluation_rubric"]),
		"attempts":             coalesceInt(r["attempts"], 1),
		"order_index":          r["order_index"],
		"output_type":          jsv.Or(r["output_type"], "text"),
		"reference_image":      nullIfFalsy(r["reference_image"]),
		"created_at":           r["created_at"],
	}
}

func mapResult(r Obj) Obj {
	return Obj{
		"id": r["id"], "model_id": r["model_id"], "benchmark_id": r["benchmark_id"],
		"task_id": r["task_id"], "run_session_id": r["run_session_id"],
		"score": normalizeScore(r["score"]), "notes": r["notes"], "thinking_notes": r["thinking_notes"],
		"response_preview": r["response_preview"], "artifact_path": r["artifact_path"],
		"attempt_number": coalesceInt(r["attempt_number"], 1),
		"tokens_used":    r["tokens_used"], "input_tokens": r["input_tokens"], "output_tokens": r["output_tokens"],
		"estimated_cost_usd": r["estimated_cost_usd"], "duration_ms": r["duration_ms"], "run_at": r["run_at"],
	}
}

func mapRun(r Obj) Obj {
	if r == nil {
		return nil
	}
	return Obj{"id": r["id"], "name": r["name"], "started_at": r["started_at"], "finished_at": r["finished_at"], "status": r["status"]}
}

func mapRunSession(r Obj) Obj {
	if r == nil {
		return nil
	}
	return Obj{
		"id": r["id"], "model_id": r["model_id"], "benchmark_ids": safeJSONArray(r["benchmark_ids"]), "status": r["status"],
		"current_benchmark_id": r["current_benchmark_id"], "current_task_id": r["current_task_id"],
		"completed_task_ids": safeJSONArray(r["completed_task_ids"]), "started_at": r["started_at"], "updated_at": r["updated_at"],
	}
}

func mapList(rows []Obj, f func(Obj) Obj) []Obj {
	out := make([]Obj, 0, len(rows))
	for _, r := range rows {
		out = append(out, f(r))
	}
	return out
}

// ---------- models ----------

const modelSelect = `id, name, mode, provider, base_url, api_key, model_id, active, input_price_per_1m, output_price_per_1m, pricing_source, pricing_model_id, pricing_updated_at, created_at`

func (s *Store) GetModels() ([]Obj, error) {
	rows, err := s.all(`SELECT ` + modelSelect + ` FROM models ORDER BY id DESC`)
	return mapList(rows, mapModel), err
}

func (s *Store) GetModelByID(id any) (Obj, error) {
	r, err := s.one(`SELECT `+modelSelect+` FROM models WHERE id = ?`, bindID(id))
	if r == nil {
		return nil, err
	}
	return mapModel(r), err
}

func bindID(id any) any {
	b, err := jsv.Bind(id)
	if err != nil {
		return nil
	}
	return b
}

// GetEffectiveModelConfig resolves the API key/base URL from provider_configs.
func (s *Store) GetEffectiveModelConfig(id any) (Obj, error) {
	m, err := s.GetModelByID(id)
	if err != nil || m == nil {
		return nil, err
	}
	if k, _ := m["api_key"].(string); strings.TrimSpace(k) != "" {
		return m, nil
	}
	if jsv.Truthy(m["provider"]) && m["mode"] == "api" {
		pc, err := s.GetProviderConfig(jsv.String(m["provider"]))
		if err != nil {
			return nil, err
		}
		if pc != nil && jsv.Truthy(pc["api_key"]) {
			c := copyObj(m)
			c["api_key"] = pc["api_key"]
			return c, nil
		}
		if pc != nil && jsv.Truthy(pc["base_url"]) && !jsv.Truthy(m["base_url"]) {
			c := copyObj(m)
			c["base_url"] = pc["base_url"]
			return c, nil
		}
	}
	return m, nil
}

func copyObj(m Obj) Obj {
	c := Obj{}
	for k, v := range m {
		c[k] = v
	}
	return c
}

func (s *Store) AddModel(data Obj) (Obj, error) {
	if data == nil {
		return nil, errors.New("model payload is required")
	}
	if !jsv.Truthy(data["name"]) {
		return nil, errors.New("NOT NULL constraint failed: models.name")
	}
	key, err := encryptOrNil(data["api_key"])
	if err != nil {
		return nil, err
	}
	active := int64(1)
	if data["active"] != nil && !jsv.Truthy(data["active"]) {
		active = 0
	}
	res, err := s.exec(`INSERT INTO models (name, mode, provider, base_url, api_key, model_id, active, input_price_per_1m, output_price_per_1m, pricing_source, pricing_model_id, pricing_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		data["name"], data["mode"], nullIfFalsy(data["provider"]), nullIfFalsy(data["base_url"]), key, nullIfFalsy(data["model_id"]), active,
		data["input_price_per_1m"], data["output_price_per_1m"], nullIfFalsy(data["pricing_source"]), nullIfFalsy(data["pricing_model_id"]), nullIfFalsy(data["pricing_updated_at"]))
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetModelByID(id)
}

var modelFields = [][2]string{
	{"name", "name"}, {"mode", "mode"}, {"provider", "provider"}, {"base_url", "base_url"}, {"api_key", "api_key"}, {"model_id", "model_id"},
	{"active", "active"},
	{"input_price_per_1m", "input_price_per_1m"}, {"output_price_per_1m", "output_price_per_1m"}, {"pricing_source", "pricing_source"},
	{"pricing_model_id", "pricing_model_id"}, {"pricing_updated_at", "pricing_updated_at"},
}

func (s *Store) UpdateModel(id any, data Obj) (Obj, error) {
	normalized := copyObj(data)
	if jsv.Has(normalized, "api_key") {
		k, err := encryptOrNil(normalized["api_key"])
		if err != nil {
			return nil, err
		}
		normalized["api_key"] = k
	}
	q, args, err := updateQuery("models", modelFields, id, normalized, "")
	if err != nil {
		return nil, err
	}
	if q != "" {
		if _, err := s.db.Exec(q, args...); err != nil {
			return nil, err
		}
	}
	return s.GetModelByID(id)
}

func (s *Store) DeleteModel(id any) (Obj, error) {
	judge, _, err := s.GetPreference("judge_model_id")
	if err != nil {
		return nil, err
	}
	if judge != nil && jsv.Number(judge) == jsv.Number(id) {
		if err := s.SavePreference("judge_model_id", nil); err != nil {
			return nil, err
		}
	}
	if _, err := s.exec(`DELETE FROM run_sessions WHERE model_id = ?`, id); err != nil {
		return nil, err
	}
	res, err := s.exec(`DELETE FROM models WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	return changes(res), nil
}

// ---------- discovered models ----------

func (s *Store) GetDiscoveredModels(provider string) ([]Obj, error) {
	var rows []Obj
	var err error
	if provider != "" {
		rows, err = s.all(`SELECT provider, model_id, base_url, last_seen_at FROM discovered_models WHERE provider = ? ORDER BY provider ASC, model_id ASC`, provider)
	} else {
		rows, err = s.all(`SELECT provider, model_id, base_url, last_seen_at FROM discovered_models ORDER BY provider ASC, model_id ASC`)
	}
	return mapList(rows, func(r Obj) Obj {
		return Obj{"provider": r["provider"], "modelId": r["model_id"], "baseUrl": nullIfFalsy(r["base_url"]), "lastSeenAt": r["last_seen_at"]}
	}), err
}

type Discovered struct{ Provider, ModelID, BaseURL string }

func (s *Store) SaveDiscoveredModels(items []Discovered) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	for _, it := range items {
		if it.Provider == "" || it.ModelID == "" {
			continue
		}
		var base any
		if it.BaseURL != "" {
			base = it.BaseURL
		}
		if _, err := tx.Exec(`INSERT INTO discovered_models (provider, model_id, base_url, last_seen_at) VALUES (?, ?, ?, datetime('now'))
			ON CONFLICT(provider, model_id) DO UPDATE SET base_url = excluded.base_url, last_seen_at = datetime('now')`, it.Provider, it.ModelID, base); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// ---------- benchmarks ----------

const benchSelect = `id, name, category, description, suite_name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, output_type, reference_image, created_at`

func (s *Store) GetBenchmarks() ([]Obj, error) {
	rows, err := s.all(`SELECT ` + benchSelect + ` FROM benchmarks ORDER BY id DESC`)
	return mapList(rows, mapBenchmark), err
}

func (s *Store) GetBenchmarkByID(id any) (Obj, error) {
	r, err := s.one(`SELECT `+benchSelect+` FROM benchmarks WHERE id = ?`, bindID(id))
	if r == nil {
		return nil, err
	}
	return mapBenchmark(r), err
}

func arrayOrEmpty(values ...any) any {
	for _, v := range values {
		if jsv.IsArr(v) {
			return v
		}
	}
	return []any{}
}

func (s *Store) AddBenchmark(d Obj) (Obj, error) {
	if d == nil {
		return nil, errors.New("benchmark payload is required")
	}
	res, err := s.exec(`INSERT INTO benchmarks (name, category, description, suite_name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, output_type, reference_image)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d["name"], d["category"], nullIfFalsy(d["description"]), nullIfFalsy(d["suite_name"]),
		jsv.Or(d["prompt_template"], d["promptTemplate"], ""), jsv.Or(d["score_type"], d["scoreType"], "numeric"),
		jsv.Or(d["expected_answer"], d["expectedAnswer"], nil), jsv.Or(d["pass_condition"], d["passCondition"], nil),
		jsv.JSONString(arrayOrEmpty(d["evaluation_checklist"], d["evaluationChecklist"])),
		jsv.JSONString(arrayOrEmpty(d["evaluation_rubric"], d["evaluationRubric"])),
		jsv.Or(d["attempts"], 1.0), jsv.Or(d["output_type"], d["outputType"], "text"), jsv.Or(d["reference_image"], d["referenceImage"], nil))
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetBenchmarkByID(id)
}

var benchmarkFields = [][2]string{
	{"name", "name"}, {"category", "category"}, {"description", "description"}, {"suite_name", "suite_name"},
	{"prompt_template", "prompt_template"}, {"promptTemplate", "prompt_template"},
	{"score_type", "score_type"}, {"scoreType", "score_type"},
	{"expected_answer", "expected_answer"}, {"expectedAnswer", "expected_answer"},
	{"pass_condition", "pass_condition"}, {"passCondition", "pass_condition"},
	{"evaluation_checklist", "evaluation_checklist"}, {"evaluationChecklist", "evaluation_checklist"},
	{"evaluation_rubric", "evaluation_rubric"}, {"evaluationRubric", "evaluation_rubric"},
	{"attempts", "attempts"}, {"output_type", "output_type"}, {"outputType", "output_type"},
	{"reference_image", "reference_image"}, {"referenceImage", "reference_image"},
}

func (s *Store) UpdateBenchmark(id any, data Obj) (Obj, error) {
	n := copyObj(data)
	for _, k := range []string{"evaluationChecklist", "evaluation_checklist", "evaluationRubric", "evaluation_rubric"} {
		if jsv.Has(n, k) {
			n[k] = jsv.JSONString(arrayOrEmpty(n[k]))
		}
	}
	q, args, err := updateQuery("benchmarks", benchmarkFields, id, n, "")
	if err != nil {
		return nil, err
	}
	if q != "" {
		if _, err := s.db.Exec(q, args...); err != nil {
			return nil, err
		}
	}
	return s.GetBenchmarkByID(id)
}

func (s *Store) DeleteBenchmark(id any) (Obj, error) {
	res, err := s.exec(`DELETE FROM benchmarks WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	return changes(res), nil
}

// ---------- tasks ----------

const taskSelect = `id, benchmark_id, name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, order_index, output_type, reference_image, created_at`

func (s *Store) GetTasks(benchmarkID any) ([]Obj, error) {
	rows, err := s.all(`SELECT `+taskSelect+` FROM tasks WHERE benchmark_id = ? ORDER BY order_index ASC, id ASC`, bindID(benchmarkID))
	return mapList(rows, mapTask), err
}

func (s *Store) GetAllTasks() ([]Obj, error) {
	rows, err := s.all(`SELECT ` + taskSelect + ` FROM tasks ORDER BY benchmark_id ASC, order_index ASC, id ASC`)
	return mapList(rows, mapTask), err
}

func (s *Store) GetTaskByID(id any) (Obj, error) {
	r, err := s.one(`SELECT `+taskSelect+` FROM tasks WHERE id = ?`, bindID(id))
	if r == nil {
		return nil, err
	}
	return mapTask(r), err
}

func (s *Store) AddTask(d Obj) (Obj, error) {
	if d == nil {
		return nil, errors.New("task payload is required")
	}
	res, err := s.exec(`INSERT INTO tasks (benchmark_id, name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, order_index, output_type, reference_image)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d["benchmarkId"], d["name"], d["promptTemplate"], d["scoreType"], nullIfFalsy(d["expectedAnswer"]), nullIfFalsy(d["passCondition"]),
		jsv.JSONString(arrayOrEmpty(d["evaluationChecklist"])), jsv.JSONString(arrayOrEmpty(d["evaluationRubric"])),
		jsv.Or(d["attempts"], 1.0), jsv.Or(d["orderIndex"], 0.0), jsv.Or(d["outputType"], "text"), nullIfFalsy(d["referenceImage"]))
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetTaskByID(id)
}

var taskFields = [][2]string{
	{"benchmarkId", "benchmark_id"}, {"name", "name"}, {"promptTemplate", "prompt_template"}, {"scoreType", "score_type"},
	{"expectedAnswer", "expected_answer"}, {"passCondition", "pass_condition"},
	{"evaluation_checklist", "evaluation_checklist"}, {"evaluation_rubric", "evaluation_rubric"},
	{"attempts", "attempts"}, {"orderIndex", "order_index"}, {"outputType", "output_type"}, {"referenceImage", "reference_image"},
}

func (s *Store) UpdateTask(id any, data Obj) (Obj, error) {
	n := copyObj(data)
	if jsv.Has(n, "evaluationChecklist") {
		n["evaluation_checklist"] = jsv.JSONString(arrayOrEmpty(n["evaluationChecklist"]))
		delete(n, "evaluationChecklist")
	}
	if jsv.Has(n, "evaluationRubric") {
		n["evaluation_rubric"] = jsv.JSONString(arrayOrEmpty(n["evaluationRubric"]))
		delete(n, "evaluationRubric")
	}
	q, args, err := updateQuery("tasks", taskFields, id, n, "")
	if err != nil {
		return nil, err
	}
	if q != "" {
		if _, err := s.db.Exec(q, args...); err != nil {
			return nil, err
		}
	}
	return s.GetTaskByID(id)
}

func (s *Store) DeleteTask(id any) (Obj, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`DELETE FROM results WHERE task_id = ?`, bindID(id)); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	res, err := tx.Exec(`DELETE FROM tasks WHERE id = ?`, bindID(id))
	if err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return changes(res), nil
}

func (s *Store) ReorderTasks(benchmarkID any, ordered []any) ([]Obj, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	for i, tid := range ordered {
		if _, err := tx.Exec(`UPDATE tasks SET order_index = ? WHERE id = ? AND benchmark_id = ?`, i, bindID(tid), bindID(benchmarkID)); err != nil {
			_ = tx.Rollback()
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetTasks(benchmarkID)
}

// ---------- results ----------

const resultSelect = `id, model_id, benchmark_id, task_id, run_session_id, score, notes, thinking_notes, response_preview, artifact_path, attempt_number, tokens_used, input_tokens, output_tokens, estimated_cost_usd, duration_ms, run_at`

func (s *Store) GetResults() ([]Obj, error) {
	rows, err := s.all(`SELECT ` + resultSelect + ` FROM results ORDER BY datetime(run_at) DESC, id DESC`)
	return mapList(rows, mapResult), err
}

func (s *Store) getResult(id any) (Obj, error) {
	r, err := s.one(`SELECT `+resultSelect+` FROM results WHERE id = ?`, bindID(id))
	if r == nil {
		return nil, err
	}
	return mapResult(r), err
}

func (s *Store) GetLatestTaskResult(modelID, benchmarkID, taskID any, startedAt string) (Obj, error) {
	var r Obj
	var err error
	if startedAt != "" {
		r, err = s.one(`SELECT `+resultSelect+` FROM results WHERE model_id = ? AND benchmark_id = ? AND task_id = ? AND datetime(run_at) >= datetime(?) ORDER BY id DESC LIMIT 1`, bindID(modelID), bindID(benchmarkID), bindID(taskID), startedAt)
	} else {
		r, err = s.one(`SELECT `+resultSelect+` FROM results WHERE model_id = ? AND benchmark_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1`, bindID(modelID), bindID(benchmarkID), bindID(taskID))
	}
	if r == nil {
		return nil, err
	}
	return mapResult(r), err
}

func (s *Store) writeArtifactsForResult(result Obj) (Obj, error) {
	model, err := s.GetModelByID(result["model_id"])
	if err != nil {
		return nil, err
	}
	bench, err := s.GetBenchmarkByID(result["benchmark_id"])
	if err != nil {
		return nil, err
	}
	if bench == nil {
		return result, nil
	}
	var task Obj
	if jsv.Truthy(result["task_id"]) {
		if task, err = s.GetTaskByID(result["task_id"]); err != nil {
			return nil, err
		}
	}
	tasks, err := s.GetTasks(result["benchmark_id"])
	if err != nil {
		return nil, err
	}
	snapshot := copyObj(bench)
	snapshot["tasks"] = tasks
	preview := artifacts.PreviewText(jsv.Str(result["notes"]))
	var previewVal any
	if preview != "" {
		previewVal = preview
	}
	withPreview := copyObj(result)
	withPreview["response_preview"] = preview
	rel, werr := artifacts.WriteResult(withPreview, model, snapshot, task)
	if werr != nil {
		log.Printf("[artifacts] Failed to write result artifacts: %v", werr)
		if _, err := s.db.Exec(`UPDATE results SET response_preview = ? WHERE id = ?`, previewVal, bindID(result["id"])); err != nil {
			return nil, err
		}
		return s.getResult(result["id"])
	}
	if _, err := s.db.Exec(`UPDATE results SET artifact_path = ?, response_preview = ? WHERE id = ?`, rel, previewVal, bindID(result["id"])); err != nil {
		return nil, err
	}
	return s.getResult(result["id"])
}

// EnsureResultArtifacts writes artifacts for results that have none.
func (s *Store) EnsureResultArtifacts() (int, error) {
	if !s.WriteArtifacts {
		return 0, nil
	}
	rows, err := s.all(`SELECT ` + resultSelect + ` FROM results WHERE artifact_path IS NULL OR artifact_path = '' ORDER BY id ASC`)
	if err != nil {
		return 0, err
	}
	for _, r := range rows {
		if _, err := s.writeArtifactsForResult(mapResult(r)); err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}

func (s *Store) estimateResultCost(d Obj) (any, error) {
	if v := d["estimated_cost_usd"]; v != nil && v != "" {
		f := jsv.Number(v)
		if f == 0 || math.IsNaN(f) {
			return nil, nil
		}
		return f, nil
	}
	model, err := s.GetModelByID(d["model_id"])
	if err != nil || model == nil {
		return nil, err
	}
	in := jsv.Number(model["input_price_per_1m"])
	out := jsv.Number(model["output_price_per_1m"])
	finite := func(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }
	if !finite(in) && !finite(out) {
		return nil, nil
	}
	inTok := jsv.Number(jsv.Coalesce(d["input_tokens"], d["inputTokens"], 0.0))
	outTok := jsv.Number(jsv.Coalesce(d["output_tokens"], d["outputTokens"], 0.0))
	if inTok > 0 || outTok > 0 {
		cost := 0.0
		if inTok > 0 && finite(in) {
			cost += inTok * in / 1_000_000
		}
		if outTok > 0 && finite(out) {
			cost += outTok * out / 1_000_000
		}
		if cost > 0 {
			return jsv.ToFixed(cost, 8), nil
		}
		return nil, nil
	}
	total := jsv.Number(jsv.Coalesce(d["tokens_used"], d["tokensUsed"], 0.0))
	if !(total > 0) {
		return nil, nil
	}
	var price float64
	switch {
	case finite(in) && finite(out):
		price = (in + out) / 2
	case finite(in):
		price = in
	default:
		price = out
	}
	if !finite(price) {
		return nil, nil
	}
	return jsv.ToFixed(total*price/1_000_000, 8), nil
}

// AddResult inserts a result (same coercions as the JS addResult) and writes
// its artifacts.
func (s *Store) AddResult(d Obj) (Obj, error) {
	if d == nil {
		return nil, errors.New("result payload is required")
	}
	preview := artifacts.PreviewText(jsv.Str(d["notes"]))
	var previewVal any
	if preview != "" {
		previewVal = preview
	}
	cost, err := s.estimateResultCost(d)
	if err != nil {
		return nil, err
	}
	score := jsv.String(d["score"])
	if _, ok := d["score"]; !ok {
		score = "undefined" // String(undefined), as in the JS build
	}
	res, err := s.exec(`INSERT INTO results (model_id, benchmark_id, task_id, run_session_id, score, notes, thinking_notes, response_preview, artifact_path, attempt_number, tokens_used, input_tokens, output_tokens, estimated_cost_usd, duration_ms, run_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
		d["model_id"], d["benchmark_id"], nullIfFalsy(d["task_id"]), jsv.Or(d["run_session_id"], d["runSessionId"], nil),
		score, nullIfFalsy(d["notes"]), jsv.Or(d["thinking_notes"], d["thinkingNotes"], nil), previewVal,
		jsv.Or(d["artifact_path"], d["artifactPath"], nil), jsv.Or(d["attempt_number"], 1.0),
		jsv.Coalesce(d["tokens_used"]), jsv.Coalesce(d["input_tokens"], d["inputTokens"]), jsv.Coalesce(d["output_tokens"], d["outputTokens"]),
		cost, jsv.Coalesce(d["duration_ms"]), nullIfFalsy(d["run_at"]))
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	created, err := s.getResult(id)
	if err != nil || created == nil || !s.WriteArtifacts {
		return created, err
	}
	return s.writeArtifactsForResult(created)
}

func (s *Store) DeleteResult(id any) (Obj, error) {
	r, err := s.one(`SELECT artifact_path FROM results WHERE id = ?`, bindID(id))
	if err != nil {
		return nil, err
	}
	if r != nil {
		if p := jsv.Str(r["artifact_path"]); p != "" {
			artifacts.Remove(p)
		}
	}
	res, err := s.exec(`DELETE FROM results WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	return changes(res), nil
}

func (s *Store) execTx(stmts ...string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	for _, q := range stmts {
		if _, err := tx.Exec(q); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ClearResultsData() (Obj, error) {
	if err := s.execTx(`DELETE FROM run_sessions;`, `DELETE FROM results;`, `DELETE FROM runs;`,
		`DELETE FROM sqlite_sequence WHERE name IN ('results', 'runs', 'run_sessions');`); err != nil {
		return nil, err
	}
	artifacts.Clear()
	results, err := s.GetResults()
	if err != nil {
		return nil, err
	}
	runs, err := s.GetRuns()
	if err != nil {
		return nil, err
	}
	return Obj{"results": results, "runs": runs}, nil
}

// ---------- runs ----------

func (s *Store) GetRuns() ([]Obj, error) {
	rows, err := s.all(`SELECT id, name, started_at, finished_at, status FROM runs ORDER BY datetime(started_at) DESC, id DESC`)
	return mapList(rows, mapRun), err
}

func (s *Store) getRun(id any) (Obj, error) {
	r, err := s.one(`SELECT id, name, started_at, finished_at, status FROM runs WHERE id = ?`, bindID(id))
	return mapRun(r), err
}

func (s *Store) AddRun(d Obj) (Obj, error) {
	if d == nil {
		d = Obj{}
	}
	res, err := s.exec(`INSERT INTO runs (name, started_at, finished_at, status) VALUES (?, COALESCE(?, datetime('now')), ?, COALESCE(?, 'pending'))`,
		nullIfFalsy(d["name"]), jsv.Or(d["started_at"], d["startedAt"], nil), jsv.Or(d["finished_at"], d["finishedAt"], nil), jsv.Or(d["status"], "pending"))
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.getRun(id)
}

func (s *Store) UpdateRun(id any, d Obj) (Obj, error) {
	q, args, err := updateQuery("runs", [][2]string{{"name", "name"}, {"started_at", "started_at"}, {"startedAt", "started_at"}, {"finished_at", "finished_at"}, {"finishedAt", "finished_at"}, {"status", "status"}}, id, d, "")
	if err != nil {
		return nil, err
	}
	if q != "" {
		if _, err := s.db.Exec(q, args...); err != nil {
			return nil, err
		}
	}
	return s.getRun(id)
}

// ---------- run sessions ----------

func (s *Store) CreateRunSession(d Obj) (Obj, error) {
	if d == nil {
		return nil, errors.New("run session payload is required")
	}
	res, err := s.exec(`INSERT INTO run_sessions (model_id, benchmark_ids, status, current_benchmark_id, current_task_id, completed_task_ids) VALUES (?, ?, COALESCE(?, 'running'), ?, ?, ?)`,
		d["model_id"], jsv.JSONString(arrayOrEmpty(d["benchmark_ids"])), jsv.Or(d["status"], "running"),
		nullIfFalsy(d["current_benchmark_id"]), nullIfFalsy(d["current_task_id"]), jsv.JSONString(arrayOrEmpty(d["completed_task_ids"])))
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetRunSession(id)
}

func (s *Store) GetRunSession(id any) (Obj, error) {
	r, err := s.one(`SELECT * FROM run_sessions WHERE id = ?`, bindID(id))
	return mapRunSession(r), err
}

func (s *Store) GetActiveRunSession() (Obj, error) {
	r, err := s.one(`SELECT * FROM run_sessions WHERE status IN ('running', 'interrupted') ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1`)
	return mapRunSession(r), err
}

func (s *Store) UpdateRunSession(id any, d Obj) (Obj, error) {
	p := copyObj(d)
	if jsv.Has(p, "benchmark_ids") {
		p["benchmark_ids"] = jsv.JSONString(arrayOrEmpty(p["benchmark_ids"]))
	}
	if jsv.Has(p, "completed_task_ids") {
		p["completed_task_ids"] = jsv.JSONString(arrayOrEmpty(p["completed_task_ids"]))
	}
	q, args, err := updateQuery("run_sessions", [][2]string{
		{"model_id", "model_id"}, {"benchmark_ids", "benchmark_ids"}, {"status", "status"},
		{"current_benchmark_id", "current_benchmark_id"}, {"current_task_id", "current_task_id"}, {"completed_task_ids", "completed_task_ids"},
	}, id, p, "updated_at = datetime('now')")
	if err != nil {
		return nil, err
	}
	if q == "" {
		_, err = s.db.Exec(`UPDATE run_sessions SET updated_at = datetime('now') WHERE id = ?`, bindID(id))
	} else {
		_, err = s.db.Exec(q, args...)
	}
	if err != nil {
		return nil, err
	}
	return s.GetRunSession(id)
}

func (s *Store) FinishRunSession(id any) (Obj, error) {
	return s.UpdateRunSession(id, Obj{"status": "finished", "current_task_id": nil})
}

func (s *Store) CancelRunSession(id any) (Obj, error) {
	return s.UpdateRunSession(id, Obj{"status": "cancelled", "current_task_id": nil})
}

func (s *Store) InterruptActiveRunSessions() error {
	_, err := s.db.Exec(`UPDATE run_sessions SET status = 'interrupted', updated_at = datetime('now') WHERE status = 'running'`)
	return err
}

// ---------- export / import ----------

func (s *Store) GetAllData() (Obj, error) {
	models, err := s.GetModels()
	if err != nil {
		return nil, err
	}
	for _, m := range models {
		m["api_key"] = nil
	}
	benchmarks, err := s.GetBenchmarks()
	if err != nil {
		return nil, err
	}
	tasks, err := s.GetAllTasks()
	if err != nil {
		return nil, err
	}
	results, err := s.GetResults()
	if err != nil {
		return nil, err
	}
	runs, err := s.GetRuns()
	if err != nil {
		return nil, err
	}
	return Obj{"models": models, "benchmarks": benchmarks, "tasks": tasks, "results": results, "runs": runs}, nil
}

func (s *Store) ClearAllData() (Obj, error) {
	if err := s.execTx(`DELETE FROM run_sessions;`, `DELETE FROM results;`, `DELETE FROM runs;`, `DELETE FROM tasks;`, `DELETE FROM benchmarks;`,
		`DELETE FROM discovered_models;`, `DELETE FROM models;`,
		`DELETE FROM sqlite_sequence WHERE name IN ('models', 'benchmarks', 'tasks', 'results', 'runs', 'run_sessions');`); err != nil {
		return nil, err
	}
	artifacts.Clear()
	return s.GetAllData()
}

func objList(v any) ([]Obj, error) {
	out := []Obj{}
	for i, item := range jsv.AsArr(v) {
		m := jsv.AsObj(item)
		if m == nil {
			return nil, fmt.Errorf("item %d is not an object", i)
		}
		out = append(out, m)
	}
	return out, nil
}

// ReplaceAllData imports a BenchForge export (models, benchmarks, tasks,
// results, runs) in one transaction.
func (s *Store) ReplaceAllData(data Obj) (Obj, error) {
	models, err := objList(data["models"])
	if err != nil {
		return nil, fmt.Errorf("models: %w", err)
	}
	benchmarks, err := objList(data["benchmarks"])
	if err != nil {
		return nil, fmt.Errorf("benchmarks: %w", err)
	}
	tasks, err := objList(data["tasks"])
	if err != nil {
		return nil, fmt.Errorf("tasks: %w", err)
	}
	results, err := objList(data["results"])
	if err != nil {
		return nil, fmt.Errorf("results: %w", err)
	}
	runs, err := objList(data["runs"])
	if err != nil {
		return nil, fmt.Errorf("runs: %w", err)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	fail := func(e error) (Obj, error) { _ = tx.Rollback(); return nil, e }
	for _, q := range []string{`DELETE FROM results;`, `DELETE FROM tasks;`, `DELETE FROM runs;`, `DELETE FROM run_sessions;`, `DELETE FROM benchmarks;`,
		`DELETE FROM discovered_models;`, `DELETE FROM models;`,
		`DELETE FROM sqlite_sequence WHERE name IN ('models', 'benchmarks', 'tasks', 'results', 'runs', 'run_sessions');`} {
		if _, err := tx.Exec(q); err != nil {
			return fail(err)
		}
	}
	ins := func(q string, values ...any) error {
		args, err := bindAll(values...)
		if err != nil {
			return err
		}
		_, err = tx.Exec(q, args...)
		return err
	}
	for _, m := range models {
		key, err := encryptOrNil(m["api_key"])
		if err != nil {
			return fail(err)
		}
		if err := ins(`INSERT INTO models (id, name, mode, provider, base_url, api_key, model_id, input_price_per_1m, output_price_per_1m, pricing_source, pricing_model_id, pricing_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
			m["id"], m["name"], jsv.Or(m["mode"], "api"), nullIfFalsy(m["provider"]), nullIfFalsy(m["base_url"]), key, nullIfFalsy(m["model_id"]),
			jsv.Coalesce(m["input_price_per_1m"]), jsv.Coalesce(m["output_price_per_1m"]), nullIfFalsy(m["pricing_source"]), nullIfFalsy(m["pricing_model_id"]), nullIfFalsy(m["pricing_updated_at"]), nullIfFalsy(m["created_at"])); err != nil {
			return fail(fmt.Errorf("import model: %w", err))
		}
	}
	for _, b := range benchmarks {
		if err := ins(`INSERT INTO benchmarks (id, name, category, description, suite_name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, output_type, reference_image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
			b["id"], b["name"], b["category"], b["description"], nullIfFalsy(b["suite_name"]), jsv.Or(b["prompt_template"], ""), jsv.Or(b["score_type"], "numeric"),
			nullIfFalsy(b["expected_answer"]), nullIfFalsy(b["pass_condition"]), jsv.JSONString(arrayOrEmpty(b["evaluation_checklist"])), jsv.JSONString(arrayOrEmpty(b["evaluation_rubric"])),
			jsv.Or(b["attempts"], 1.0), jsv.Or(b["output_type"], "text"), nullIfFalsy(b["reference_image"]), nullIfFalsy(b["created_at"])); err != nil {
			return fail(fmt.Errorf("import benchmark: %w", err))
		}
	}
	for _, t := range tasks {
		if err := ins(`INSERT INTO tasks (id, benchmark_id, name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, order_index, output_type, reference_image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
			t["id"], t["benchmark_id"], t["name"], t["prompt_template"], t["score_type"], nullIfFalsy(t["expected_answer"]), t["pass_condition"],
			jsv.JSONString(arrayOrEmpty(t["evaluation_checklist"])), jsv.JSONString(arrayOrEmpty(t["evaluation_rubric"])), jsv.Or(t["attempts"], 1.0), t["order_index"],
			jsv.Or(t["output_type"], "text"), nullIfFalsy(t["reference_image"]), nullIfFalsy(t["created_at"])); err != nil {
			return fail(fmt.Errorf("import task: %w", err))
		}
	}
	for _, r := range results {
		preview := jsv.Or(r["response_preview"], artifacts.PreviewText(jsv.Str(r["notes"])), nil)
		if err := ins(`INSERT INTO results (id, model_id, benchmark_id, task_id, run_session_id, score, notes, thinking_notes, response_preview, artifact_path, attempt_number, tokens_used, input_tokens, output_tokens, estimated_cost_usd, duration_ms, run_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, COALESCE(?, 1), ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
			r["id"], r["model_id"], r["benchmark_id"], r["task_id"], scoreForImport(r["score"]), r["notes"], nullIfFalsy(r["thinking_notes"]), preview,
			jsv.Or(r["attempt_number"], 1.0), jsv.Coalesce(r["tokens_used"]), jsv.Coalesce(r["input_tokens"]), jsv.Coalesce(r["output_tokens"]),
			jsv.Coalesce(r["estimated_cost_usd"]), jsv.Coalesce(r["duration_ms"]), nullIfFalsy(r["run_at"])); err != nil {
			return fail(fmt.Errorf("import result: %w", err))
		}
	}
	for _, r := range runs {
		if err := ins(`INSERT INTO runs (id, name, started_at, finished_at, status) VALUES (?, ?, COALESCE(?, datetime('now')), ?, COALESCE(?, 'pending'))`,
			r["id"], r["name"], nullIfFalsy(r["started_at"]), nullIfFalsy(r["finished_at"]), r["status"]); err != nil {
			return fail(fmt.Errorf("import run: %w", err))
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	artifacts.Clear()
	if _, err := s.EnsureResultArtifacts(); err != nil {
		return nil, err
	}
	return s.GetAllData()
}

func scoreForImport(v any) any {
	if v == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		return s
	}
	return jsv.String(v)
}

// ---------- preferences ----------

func parsePreferenceValue(v any) any {
	s, ok := v.(string)
	if !ok {
		return v
	}
	var out any
	if err := jsonUnmarshal(s, &out); err != nil {
		return s
	}
	return out
}

// SavePreference stores JSON.stringify(value) (secret keys encrypted first).
func (s *Store) SavePreference(key string, value any) error {
	stored := value
	if secretPreferenceKeys[key] {
		enc, err := encryptOrNil(value)
		if err != nil {
			return err
		}
		stored = enc
	}
	_, err := s.db.Exec(`INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)`, key, jsv.JSONString(stored))
	return err
}

// GetPreference returns (value, found).
func (s *Store) GetPreference(key string) (any, bool, error) {
	r, err := s.one(`SELECT value FROM preferences WHERE key = ?`, key)
	if err != nil || r == nil || r["value"] == nil {
		return nil, false, err
	}
	parsed := parsePreferenceValue(r["value"])
	if secretPreferenceKeys[key] {
		return decryptOrNil(parsed), true, nil
	}
	return parsed, true, nil
}

// Pref is GetPreference ignoring errors (undefined -> nil).
func (s *Store) Pref(key string) any {
	v, _, err := s.GetPreference(key)
	if err != nil {
		log.Printf("[preferences] %s: %v", key, err)
	}
	return v
}

// ---------- provider configs ----------

func mapProviderConfig(r Obj) Obj {
	return Obj{
		"provider": r["provider"], "api_key": decryptOrNil(r["api_key"]), "base_url": r["base_url"],
		"display_name": nullIfFalsy(r["display_name"]), "icon_url": nullIfFalsy(r["icon_url"]),
		"is_custom": boolish(r["is_custom"]), "updated_at": r["updated_at"],
	}
}

func (s *Store) GetAllProviderConfigs() ([]Obj, error) {
	rows, err := s.all(`SELECT * FROM provider_configs`)
	return mapList(rows, mapProviderConfig), err
}

func (s *Store) GetProviderConfig(provider string) (Obj, error) {
	r, err := s.one(`SELECT * FROM provider_configs WHERE provider = ?`, provider)
	if r == nil {
		return nil, err
	}
	return mapProviderConfig(r), err
}

func (s *Store) SaveProviderConfig(provider string, d Obj) (Obj, error) {
	if d == nil {
		d = Obj{}
	}
	var key any
	if d["api_key"] != nil {
		k, err := encryptOrNil(d["api_key"])
		if err != nil {
			return nil, err
		}
		key = k
	}
	isCustom := 0
	if jsv.Truthy(d["is_custom"]) {
		isCustom = 1
	}
	if _, err := s.exec(`INSERT INTO provider_configs (provider, api_key, base_url, display_name, icon_url, is_custom, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, base_url = excluded.base_url, display_name = excluded.display_name,
		  icon_url = excluded.icon_url, is_custom = excluded.is_custom, updated_at = excluded.updated_at`,
		provider, key, nullIfFalsy(d["base_url"]), nullIfFalsy(d["display_name"]), nullIfFalsy(d["icon_url"]), isCustom); err != nil {
		return nil, err
	}
	return s.GetProviderConfig(provider)
}

func (s *Store) DeleteProviderConfig(provider string) (Obj, error) {
	res, err := s.db.Exec(`DELETE FROM provider_configs WHERE provider = ?`, provider)
	if err != nil {
		return nil, err
	}
	return changes(res), nil
}
