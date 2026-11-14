package db

import (
	"database/sql"
	"fmt"
	"strings"
)

// The schema and the additive migrations below are a 1:1 port of
// electron/database.cjs (createXTable / ensureXSchema / initDb), so a
// benchforge.db written by the Electron build opens unchanged and a database
// created here opens in the Electron build.

const createModels = `
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'api',
  provider TEXT,
  base_url TEXT,
  api_key TEXT,
  model_id TEXT,
  active INTEGER DEFAULT 1,
  input_price_per_1m REAL DEFAULT NULL,
  output_price_per_1m REAL DEFAULT NULL,
  pricing_source TEXT DEFAULT NULL,
  pricing_model_id TEXT DEFAULT NULL,
  pricing_updated_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);`

const createBenchmarks = `
CREATE TABLE IF NOT EXISTS benchmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  suite_name TEXT DEFAULT NULL,
  prompt_template TEXT DEFAULT '',
  score_type TEXT NOT NULL DEFAULT 'numeric' CHECK(score_type IN ('numeric', 'boolean')),
  expected_answer TEXT DEFAULT NULL,
  pass_condition TEXT,
  evaluation_checklist TEXT DEFAULT '[]',
  evaluation_rubric TEXT DEFAULT '[]',
  attempts INTEGER DEFAULT 1,
  output_type TEXT DEFAULT 'text',
  reference_image TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);`

const createTasks = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  benchmark_id INTEGER NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  score_type TEXT NOT NULL CHECK(score_type IN ('numeric', 'boolean')),
  expected_answer TEXT DEFAULT NULL,
  pass_condition TEXT,
  evaluation_checklist TEXT,
  evaluation_rubric TEXT DEFAULT '[]',
  attempts INTEGER DEFAULT 1,
  order_index INTEGER DEFAULT 0,
  output_type TEXT DEFAULT 'text',
  reference_image TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);`

const createCore = `
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER REFERENCES models(id) ON DELETE CASCADE,
  benchmark_id INTEGER REFERENCES benchmarks(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  run_session_id INTEGER DEFAULT NULL REFERENCES run_sessions(id) ON DELETE SET NULL,
  score TEXT NOT NULL,
  notes TEXT,
  thinking_notes TEXT DEFAULT NULL,
  response_preview TEXT DEFAULT NULL,
  artifact_path TEXT DEFAULT NULL,
  attempt_number INTEGER DEFAULT 1,
  tokens_used INTEGER DEFAULT NULL,
  input_tokens INTEGER DEFAULT NULL,
  output_tokens INTEGER DEFAULT NULL,
  estimated_cost_usd REAL DEFAULT NULL,
  duration_ms INTEGER DEFAULT NULL,
  run_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS run_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL,
  benchmark_ids TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  current_benchmark_id INTEGER,
  current_task_id INTEGER,
  completed_task_ids TEXT DEFAULT '[]',
  started_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT
);`

const createDiscovered = `
CREATE TABLE IF NOT EXISTS discovered_models (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  base_url TEXT,
  last_seen_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (provider, model_id)
);`

const createProviderConfigs = `
CREATE TABLE IF NOT EXISTS provider_configs (
  provider TEXT PRIMARY KEY,
  api_key TEXT,
  base_url TEXT,
  display_name TEXT,
  icon_url TEXT,
  is_custom INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);`

type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

func tableExists(x execer, name string) (bool, error) {
	var n string
	err := x.QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&n)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func columns(x execer, table string) (map[string]bool, error) {
	rows, err := x.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols[name] = true
	}
	return cols, rows.Err()
}

func addMissing(x execer, table string, cols map[string]bool, additions [][2]string) error {
	for _, a := range additions {
		if cols[a[0]] {
			continue
		}
		if _, err := x.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + a[0] + ` ` + a[1] + `;`); err != nil {
			return fmt.Errorf("add %s.%s: %w", table, a[0], err)
		}
		cols[a[0]] = true
	}
	return nil
}

var modelPricingColumns = [][2]string{
	{"input_price_per_1m", "REAL DEFAULT NULL"},
	{"output_price_per_1m", "REAL DEFAULT NULL"},
	{"pricing_source", "TEXT DEFAULT NULL"},
	{"pricing_model_id", "TEXT DEFAULT NULL"},
	{"pricing_updated_at", "TEXT DEFAULT NULL"},
	{"active", "INTEGER DEFAULT 1"},
}

func ensureModelsSchema(s *Store) error {
	ok, err := tableExists(s.db, "models")
	if err != nil {
		return err
	}
	if !ok {
		_, err := s.db.Exec(createModels)
		return err
	}
	cols, err := columns(s.db, "models")
	if err != nil {
		return err
	}
	expected := []string{"id", "name", "mode", "provider", "base_url", "api_key", "model_id", "created_at"}
	all := true
	for _, c := range expected {
		if !cols[c] {
			all = false
		}
	}
	if all {
		return addMissing(s.db, "models", cols, modelPricingColumns)
	}
	// Legacy models table without `mode`: rebuild (same as the JS migration).
	// legacy_alter_table=ON keeps FOREIGN KEY references in results/... pointing
	// at "models"; without it SQLite >= 3.26 rewrites them to "models_legacy",
	// which is then dropped (a latent bug of the Electron migration).
	if _, err := s.db.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		return err
	}
	if _, err := s.db.Exec(`PRAGMA legacy_alter_table = ON`); err != nil {
		return err
	}
	defer s.db.Exec(`PRAGMA legacy_alter_table = OFF`)
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	stmts := []string{
		`ALTER TABLE models RENAME TO models_legacy;`,
		createModels,
		`INSERT INTO models (id, name, mode, provider, base_url, api_key, model_id, created_at)
		 SELECT id, name, 'api', provider, base_url, api_key, model_id, created_at FROM models_legacy;`,
		`DROP TABLE models_legacy;`,
	}
	for _, q := range stmts {
		if _, err := tx.Exec(q); err != nil {
			_ = tx.Rollback()
			_, _ = s.db.Exec(`PRAGMA foreign_keys = ON`)
			return fmt.Errorf("rebuild legacy models table: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if _, err := s.db.Exec(`PRAGMA foreign_keys = ON`); err != nil {
		return err
	}
	cols, err = columns(s.db, "models")
	if err != nil {
		return err
	}
	return addMissing(s.db, "models", cols, modelPricingColumns)
}

func ensureBenchmarksSchema(s *Store) error {
	staleLegacy, err := tableExists(s.db, "benchmarks_legacy")
	if err != nil {
		return err
	}
	hasBench, err := tableExists(s.db, "benchmarks")
	if err != nil {
		return err
	}
	if staleLegacy && !hasBench {
		if _, err := s.db.Exec(`ALTER TABLE benchmarks_legacy RENAME TO benchmarks;`); err != nil {
			return err
		}
	} else if staleLegacy {
		if _, err := s.db.Exec(`DROP TABLE IF EXISTS benchmarks_legacy;`); err != nil {
			return err
		}
	}
	if _, err := s.db.Exec(createTasks); err != nil {
		return err
	}
	hasBench, err = tableExists(s.db, "benchmarks")
	if err != nil {
		return err
	}
	if !hasBench {
		_, err := s.db.Exec(createBenchmarks)
		return err
	}
	cols, err := columns(s.db, "benchmarks")
	if err != nil {
		return err
	}
	if err := addMissing(s.db, "benchmarks", cols, [][2]string{{"description", "TEXT"}, {"suite_name", "TEXT DEFAULT NULL"}}); err != nil {
		return err
	}
	tcols, err := columns(s.db, "tasks")
	if err != nil {
		return err
	}
	return addMissing(s.db, "tasks", tcols, [][2]string{
		{"attempts", "INTEGER DEFAULT 1"},
		{"output_type", "TEXT DEFAULT 'text'"},
		{"reference_image", "TEXT DEFAULT NULL"},
		{"expected_answer", "TEXT DEFAULT NULL"},
		{"evaluation_rubric", "TEXT DEFAULT '[]'"},
	})
}

func ensureResultsSchema(s *Store) error {
	cols, err := columns(s.db, "results")
	if err != nil {
		return err
	}
	return addMissing(s.db, "results", cols, [][2]string{
		{"task_id", "INTEGER REFERENCES tasks(id) ON DELETE CASCADE"},
		{"attempt_number", "INTEGER DEFAULT 1"},
		{"tokens_used", "INTEGER DEFAULT NULL"},
		{"input_tokens", "INTEGER DEFAULT NULL"},
		{"output_tokens", "INTEGER DEFAULT NULL"},
		{"estimated_cost_usd", "REAL DEFAULT NULL"},
		{"duration_ms", "INTEGER DEFAULT NULL"},
		{"thinking_notes", "TEXT DEFAULT NULL"},
		{"run_session_id", "INTEGER DEFAULT NULL REFERENCES run_sessions(id) ON DELETE SET NULL"},
		{"response_preview", "TEXT DEFAULT NULL"},
		{"artifact_path", "TEXT DEFAULT NULL"},
	})
}

func ensureTasksSchema(s *Store) error {
	if _, err := s.db.Exec(createTasks); err != nil {
		return err
	}
	cols, err := columns(s.db, "tasks")
	if err != nil {
		return err
	}
	return addMissing(s.db, "tasks", cols, [][2]string{
		{"output_type", "TEXT DEFAULT 'text'"},
		{"reference_image", "TEXT DEFAULT NULL"},
		{"expected_answer", "TEXT DEFAULT NULL"},
		{"evaluation_rubric", "TEXT DEFAULT '[]'"},
	})
}

func ensureBenchmarkColumns(s *Store) error {
	if _, err := s.db.Exec(createBenchmarks); err != nil {
		return err
	}
	cols, err := columns(s.db, "benchmarks")
	if err != nil {
		return err
	}
	if err := addMissing(s.db, "benchmarks", cols, [][2]string{
		{"suite_name", "TEXT DEFAULT NULL"},
		{"prompt_template", "TEXT DEFAULT ''"},
		{"score_type", "TEXT NOT NULL DEFAULT 'numeric'"},
		{"expected_answer", "TEXT DEFAULT NULL"},
		{"pass_condition", "TEXT"},
		{"evaluation_checklist", "TEXT DEFAULT '[]'"},
		{"evaluation_rubric", "TEXT DEFAULT '[]'"},
		{"attempts", "INTEGER DEFAULT 1"},
		{"output_type", "TEXT DEFAULT 'text'"},
		{"reference_image", "TEXT DEFAULT NULL"},
	}); err != nil {
		return err
	}
	hasTasks, err := tableExists(s.db, "tasks")
	if err != nil || !hasTasks {
		return err
	}
	const first = `(SELECT %s FROM tasks WHERE tasks.benchmark_id = benchmarks.id ORDER BY order_index ASC, id ASC LIMIT 1)`
	f := func(col string) string { return fmt.Sprintf(first, col) }
	_, err = s.db.Exec(`
UPDATE benchmarks
SET
  prompt_template = COALESCE(NULLIF(prompt_template, ''), ` + f("prompt_template") + `, ''),
  score_type = COALESCE(` + f("score_type") + `, score_type, 'numeric'),
  expected_answer = COALESCE(expected_answer, ` + f("expected_answer") + `),
  pass_condition = COALESCE(pass_condition, ` + f("pass_condition") + `),
  evaluation_checklist = COALESCE(NULLIF(evaluation_checklist, '[]'), ` + f("evaluation_checklist") + `, '[]'),
  attempts = COALESCE(` + f("attempts") + `, attempts, 1),
  output_type = COALESCE(` + f("output_type") + `, output_type, 'text'),
  reference_image = COALESCE(reference_image, ` + f("reference_image") + `)
WHERE prompt_template IS NULL OR prompt_template = '';`)
	return err
}

func removeAutoGeneratedParentTasks(s *Store) error {
	hasTasks, err := tableExists(s.db, "tasks")
	if err != nil {
		return err
	}
	hasBench, err := tableExists(s.db, "benchmarks")
	if err != nil || !hasTasks || !hasBench {
		return err
	}
	_, err = s.db.Exec(`
DELETE FROM tasks
WHERE id IN (
  SELECT tasks.id
  FROM tasks
  JOIN benchmarks ON benchmarks.id = tasks.benchmark_id
  WHERE tasks.name = 'Zadanie 1'
    AND TRIM(tasks.prompt_template) = TRIM(COALESCE(benchmarks.prompt_template, ''))
    AND TRIM(tasks.prompt_template) != ''
    AND (SELECT COUNT(*) FROM tasks AS sibling_tasks WHERE sibling_tasks.benchmark_id = tasks.benchmark_id) > 1
);`)
	return err
}

func ensureProviderConfigs(s *Store) error {
	if _, err := s.db.Exec(createProviderConfigs); err != nil {
		return err
	}
	cols, err := columns(s.db, "provider_configs")
	if err != nil {
		return err
	}
	return addMissing(s.db, "provider_configs", cols, [][2]string{
		{"display_name", "TEXT"},
		{"icon_url", "TEXT"},
		{"is_custom", "INTEGER DEFAULT 0"},
	})
}

func (s *Store) migrate() error {
	steps := []struct {
		name string
		fn   func(*Store) error
	}{
		{"models", ensureModelsSchema},
		{"oauth->api", func(s *Store) error {
			_, err := s.db.Exec(`UPDATE models SET mode = 'api' WHERE mode = 'oauth'`)
			return err
		}},
		{"benchmarks", ensureBenchmarksSchema},
		{"core tables", func(s *Store) error { _, err := s.db.Exec(createCore); return err }},
		{"results", ensureResultsSchema},
		{"benchmark columns", ensureBenchmarkColumns},
		{"tasks", ensureTasksSchema},
		{"auto-generated tasks", removeAutoGeneratedParentTasks},
		{"discovered_models", func(s *Store) error { _, err := s.db.Exec(createDiscovered); return err }},
		{"provider_configs", ensureProviderConfigs},
		{"secrets", (*Store).migrateStoredSecrets},
	}
	for _, step := range steps {
		if err := step.fn(s); err != nil {
			return fmt.Errorf("migration %q: %w", step.name, err)
		}
	}
	return nil
}

func placeholders(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }
