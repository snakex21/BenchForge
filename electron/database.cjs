const path = require('path')
const Database = require('better-sqlite3')
const { clearArtifacts, previewText, removeArtifact, writeResultArtifacts } = require('./artifacts.cjs')
const { decryptSecret, encryptSecret, isEncryptedSecret } = require('./secretStore.cjs')
const { getDataPath } = require('./paths.cjs')

let db = null

const SECRET_PREFERENCE_KEYS = new Set(['github_token'])

function normalizeScore(score) {
  if (score === null || score === undefined) return ''
  return String(score)
}

function mapModelRow(row) {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    provider: row.provider,
    base_url: row.base_url,
    api_key: decryptSecret(row.api_key),
    model_id: row.model_id,
    input_price_per_1m: row.input_price_per_1m ?? null,
    output_price_per_1m: row.output_price_per_1m ?? null,
    pricing_source: row.pricing_source ?? null,
    pricing_model_id: row.pricing_model_id ?? null,
    pricing_updated_at: row.pricing_updated_at ?? null,
    created_at: row.created_at,
  }
}

function mapBenchmarkRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    suite_name: row.suite_name || null,
    prompt_template: row.prompt_template || '',
    score_type: row.score_type || 'numeric',
    expected_answer: row.expected_answer || null,
    pass_condition: row.pass_condition || null,
    evaluation_checklist: row.evaluation_checklist ? JSON.parse(row.evaluation_checklist) : [],
    evaluation_rubric: row.evaluation_rubric ? JSON.parse(row.evaluation_rubric) : [],
    attempts: row.attempts ?? 1,
    output_type: row.output_type || 'text',
    reference_image: row.reference_image || null,
    created_at: row.created_at,
  }
}

function mapTaskRow(row) {
  return {
    id: row.id,
    benchmark_id: row.benchmark_id,
    name: row.name,
    prompt_template: row.prompt_template,
    score_type: row.score_type,
    expected_answer: row.expected_answer || null,
    pass_condition: row.pass_condition,
    evaluation_checklist: row.evaluation_checklist ? JSON.parse(row.evaluation_checklist) : [],
    evaluation_rubric: row.evaluation_rubric ? JSON.parse(row.evaluation_rubric) : [],
    attempts: row.attempts ?? 1,
    order_index: row.order_index,
    output_type: row.output_type || 'text',
    reference_image: row.reference_image || null,
    created_at: row.created_at,
  }
}

function mapResultRow(row) {
  return {
    id: row.id,
    model_id: row.model_id,
    benchmark_id: row.benchmark_id,
    task_id: row.task_id ?? null,
    run_session_id: row.run_session_id ?? null,
    score: normalizeScore(row.score),
    notes: row.notes,
    thinking_notes: row.thinking_notes ?? null,
    response_preview: row.response_preview ?? null,
    artifact_path: row.artifact_path ?? null,
    attempt_number: row.attempt_number ?? 1,
    tokens_used: row.tokens_used ?? null,
    input_tokens: row.input_tokens ?? null,
    output_tokens: row.output_tokens ?? null,
    estimated_cost_usd: row.estimated_cost_usd ?? null,
    duration_ms: row.duration_ms ?? null,
    run_at: row.run_at,
  }
}

function mapRunRow(row) {
  return {
    id: row.id,
    name: row.name,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
  }
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function mapRunSessionRow(row) {
  return row ? {
    id: row.id,
    model_id: row.model_id,
    benchmark_ids: safeJsonArray(row.benchmark_ids),
    status: row.status,
    current_benchmark_id: row.current_benchmark_id,
    current_task_id: row.current_task_id,
    completed_task_ids: safeJsonArray(row.completed_task_ids),
    started_at: row.started_at,
    updated_at: row.updated_at,
  } : null
}

function buildUpdateQuery(tableName, fieldMap, id, data) {
  const payload = Object.entries(fieldMap).reduce((acc, [key, column]) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      acc[column] = data[key]
    }
    return acc
  }, {})

  const entries = Object.entries(payload)
  if (entries.length === 0) return null

  return {
    sql: `UPDATE ${tableName} SET ${entries.map(([column]) => `${column} = @${column}`).join(', ')} WHERE id = @id`,
    params: { id, ...payload },
  }
}

function normalizeModelSecretData(data) {
  const normalized = { ...data }
  if (Object.prototype.hasOwnProperty.call(normalized, 'api_key')) {
    normalized.api_key = normalized.api_key ? encryptSecret(normalized.api_key) : null
  }
  return normalized
}

function parsePreferenceValue(rowValue) {
  try {
    return JSON.parse(rowValue)
  } catch {
    return rowValue
  }
}

function serializePreferenceValue(key, value) {
  const stored = SECRET_PREFERENCE_KEYS.has(key) ? (value ? encryptSecret(value) : null) : value
  return JSON.stringify(stored)
}

function deserializePreferenceValue(key, rowValue) {
  const parsed = parsePreferenceValue(rowValue)
  return SECRET_PREFERENCE_KEYS.has(key) ? decryptSecret(parsed) : parsed
}

function migrateStoredSecrets(database) {
  try {
    const modelRows = database.prepare(`SELECT id, api_key FROM models WHERE api_key IS NOT NULL AND api_key != ''`).all()
    const updateModelSecret = database.prepare(`UPDATE models SET api_key = ? WHERE id = ?`)
    for (const row of modelRows) {
      if (isEncryptedSecret(row.api_key)) continue
      updateModelSecret.run(encryptSecret(row.api_key), row.id)
    }

    const preferenceRows = database.prepare(`SELECT key, value FROM preferences WHERE key IN (${Array.from(SECRET_PREFERENCE_KEYS).map(() => '?').join(',')})`).all(...SECRET_PREFERENCE_KEYS)
    const updatePreference = database.prepare(`UPDATE preferences SET value = ? WHERE key = ?`)
    for (const row of preferenceRows) {
      const parsed = parsePreferenceValue(row.value)
      if (!parsed || isEncryptedSecret(parsed)) continue
      updatePreference.run(JSON.stringify(encryptSecret(parsed)), row.key)
    }
  } catch (error) {
    console.warn('[secretStore] Failed to migrate stored secrets:', error)
  }
}

function getDb() {
  if (!db) initDb()
  return db
}

function createModelsTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'api',
      provider TEXT,
      base_url TEXT,
      api_key TEXT,
      model_id TEXT,
      input_price_per_1m REAL DEFAULT NULL,
      output_price_per_1m REAL DEFAULT NULL,
      pricing_source TEXT DEFAULT NULL,
      pricing_model_id TEXT DEFAULT NULL,
      pricing_updated_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

function createBenchmarksTable(database) {
  database.exec(`
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
    );
  `)
}

function createTasksTable(database) {
  database.exec(`
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
    );
  `)
}

function createDiscoveredModelsTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS discovered_models (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      base_url TEXT,
      last_seen_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (provider, model_id)
    );
  `)
}

function ensureModelsSchema(database) {
  const hasModelsTable = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'models'`).get()
  if (!hasModelsTable) {
    createModelsTable(database)
    return
  }

  let columns = database.prepare(`PRAGMA table_info(models)`).all().map((column) => column.name)
  const expected = ['id', 'name', 'mode', 'provider', 'base_url', 'api_key', 'model_id', 'created_at']
  if (expected.every((column) => columns.includes(column))) {
    const pricingColumns = [
      ['input_price_per_1m', 'REAL DEFAULT NULL'],
      ['output_price_per_1m', 'REAL DEFAULT NULL'],
      ['pricing_source', 'TEXT DEFAULT NULL'],
      ['pricing_model_id', 'TEXT DEFAULT NULL'],
      ['pricing_updated_at', 'TEXT DEFAULT NULL'],
    ]
    for (const [column, type] of pricingColumns) {
      if (!columns.includes(column)) database.exec(`ALTER TABLE models ADD COLUMN ${column} ${type};`)
    }
    return
  }

  database.pragma('foreign_keys = OFF')
  const tx = database.transaction(() => {
    database.exec(`ALTER TABLE models RENAME TO models_legacy;`)
    createModelsTable(database)
    database.exec(`
      INSERT INTO models (id, name, mode, provider, base_url, api_key, model_id, created_at)
      SELECT id, name, 'api', provider, base_url, api_key, model_id, created_at
      FROM models_legacy;
      DROP TABLE models_legacy;
    `)
  })
  tx()
  database.pragma('foreign_keys = ON')
  columns = database.prepare(`PRAGMA table_info(models)`).all().map((column) => column.name)
  for (const [column, type] of [
    ['input_price_per_1m', 'REAL DEFAULT NULL'],
    ['output_price_per_1m', 'REAL DEFAULT NULL'],
    ['pricing_source', 'TEXT DEFAULT NULL'],
    ['pricing_model_id', 'TEXT DEFAULT NULL'],
    ['pricing_updated_at', 'TEXT DEFAULT NULL'],
  ]) {
    if (!columns.includes(column)) database.exec(`ALTER TABLE models ADD COLUMN ${column} ${type};`)
  }
}

function ensureBenchmarksSchema(database) {
  const hasStaleLegacyTable = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'benchmarks_legacy'`).get()
  const hasBenchmarksTable = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'benchmarks'`).get()

  if (hasStaleLegacyTable && !hasBenchmarksTable) {
    database.exec(`ALTER TABLE benchmarks_legacy RENAME TO benchmarks;`)
  } else if (hasStaleLegacyTable) {
    database.exec(`DROP TABLE IF EXISTS benchmarks_legacy;`)
  }

  createTasksTable(database)

  const hasBenchmarksAfterCleanup = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'benchmarks'`).get()

  if (!hasBenchmarksAfterCleanup) {
    createBenchmarksTable(database)
    return
  }

  const columns = database.prepare(`PRAGMA table_info(benchmarks)`).all().map((column) => column.name)
  if (!columns.includes('description')) {
    database.exec(`ALTER TABLE benchmarks ADD COLUMN description TEXT;`)
  }
  if (!columns.includes('suite_name')) {
    database.exec(`ALTER TABLE benchmarks ADD COLUMN suite_name TEXT DEFAULT NULL;`)
  }
  const taskColumns = database.prepare(`PRAGMA table_info(tasks)`).all().map((column) => column.name)
  if (!taskColumns.includes('attempts')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN attempts INTEGER DEFAULT 1;`)
  }
  if (!taskColumns.includes('output_type')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN output_type TEXT DEFAULT 'text';`)
  }
  if (!taskColumns.includes('reference_image')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN reference_image TEXT DEFAULT NULL;`)
  }
  if (!taskColumns.includes('expected_answer')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN expected_answer TEXT DEFAULT NULL;`)
  }
  if (!taskColumns.includes('evaluation_rubric')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN evaluation_rubric TEXT DEFAULT '[]';`)
  }
}

function removeAutoGeneratedParentTasks(database) {
  const hasTasks = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`).get()
  const hasBenchmarks = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'benchmarks'`).get()
  if (!hasTasks || !hasBenchmarks) return

  database.exec(`
    DELETE FROM tasks
    WHERE id IN (
      SELECT tasks.id
      FROM tasks
      JOIN benchmarks ON benchmarks.id = tasks.benchmark_id
      WHERE tasks.name = 'Zadanie 1'
        AND TRIM(tasks.prompt_template) = TRIM(COALESCE(benchmarks.prompt_template, ''))
        AND TRIM(tasks.prompt_template) != ''
        AND (
          SELECT COUNT(*)
          FROM tasks AS sibling_tasks
          WHERE sibling_tasks.benchmark_id = tasks.benchmark_id
        ) > 1
    );
  `)
}

function ensureResultsSchema(database) {
  const columns = database.prepare(`PRAGMA table_info(results)`).all().map((column) => column.name)
  if (!columns.includes('task_id')) {
    database.exec(`ALTER TABLE results ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;`)
  }
  if (!columns.includes('attempt_number')) {
    database.exec(`ALTER TABLE results ADD COLUMN attempt_number INTEGER DEFAULT 1;`)
  }
  if (!columns.includes('tokens_used')) {
    database.exec(`ALTER TABLE results ADD COLUMN tokens_used INTEGER DEFAULT NULL;`)
  }
  if (!columns.includes('input_tokens')) {
    database.exec(`ALTER TABLE results ADD COLUMN input_tokens INTEGER DEFAULT NULL;`)
  }
  if (!columns.includes('output_tokens')) {
    database.exec(`ALTER TABLE results ADD COLUMN output_tokens INTEGER DEFAULT NULL;`)
  }
  if (!columns.includes('estimated_cost_usd')) {
    database.exec(`ALTER TABLE results ADD COLUMN estimated_cost_usd REAL DEFAULT NULL;`)
  }
  if (!columns.includes('duration_ms')) {
    database.exec(`ALTER TABLE results ADD COLUMN duration_ms INTEGER DEFAULT NULL;`)
  }
  if (!columns.includes('thinking_notes')) {
    database.exec(`ALTER TABLE results ADD COLUMN thinking_notes TEXT DEFAULT NULL;`)
  }
  if (!columns.includes('run_session_id')) {
    database.exec(`ALTER TABLE results ADD COLUMN run_session_id INTEGER DEFAULT NULL REFERENCES run_sessions(id) ON DELETE SET NULL;`)
  }
  if (!columns.includes('response_preview')) {
    database.exec(`ALTER TABLE results ADD COLUMN response_preview TEXT DEFAULT NULL;`)
  }
  if (!columns.includes('artifact_path')) {
    database.exec(`ALTER TABLE results ADD COLUMN artifact_path TEXT DEFAULT NULL;`)
  }
}

function ensureTasksSchema(database) {
  createTasksTable(database)
  const columns = database.prepare(`PRAGMA table_info(tasks)`).all().map((column) => column.name)
  if (!columns.includes('output_type')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN output_type TEXT DEFAULT 'text';`)
  }
  if (!columns.includes('reference_image')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN reference_image TEXT DEFAULT NULL;`)
  }
  if (!columns.includes('expected_answer')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN expected_answer TEXT DEFAULT NULL;`)
  }
  if (!columns.includes('evaluation_rubric')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN evaluation_rubric TEXT DEFAULT '[]';`)
  }
}

function ensureBenchmarkColumns(database) {
  createBenchmarksTable(database)
  const columns = database.prepare(`PRAGMA table_info(benchmarks)`).all().map((column) => column.name)
  if (!columns.includes('suite_name')) {
    database.exec(`ALTER TABLE benchmarks ADD COLUMN suite_name TEXT DEFAULT NULL;`)
  }
  const additions = [
    ['prompt_template', `ALTER TABLE benchmarks ADD COLUMN prompt_template TEXT DEFAULT '';`],
    ['score_type', `ALTER TABLE benchmarks ADD COLUMN score_type TEXT NOT NULL DEFAULT 'numeric';`],
    ['expected_answer', `ALTER TABLE benchmarks ADD COLUMN expected_answer TEXT DEFAULT NULL;`],
    ['pass_condition', `ALTER TABLE benchmarks ADD COLUMN pass_condition TEXT;`],
    ['evaluation_checklist', `ALTER TABLE benchmarks ADD COLUMN evaluation_checklist TEXT DEFAULT '[]';`],
    ['evaluation_rubric', `ALTER TABLE benchmarks ADD COLUMN evaluation_rubric TEXT DEFAULT '[]';`],
    ['attempts', `ALTER TABLE benchmarks ADD COLUMN attempts INTEGER DEFAULT 1;`],
    ['output_type', `ALTER TABLE benchmarks ADD COLUMN output_type TEXT DEFAULT 'text';`],
    ['reference_image', `ALTER TABLE benchmarks ADD COLUMN reference_image TEXT DEFAULT NULL;`],
  ]
  for (const [column, sql] of additions) {
    if (!columns.includes(column)) database.exec(sql)
  }

  const hasTasks = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`).get()
  if (hasTasks) {
    database.exec(`
      UPDATE benchmarks
      SET
        prompt_template = COALESCE(NULLIF(prompt_template, ''), (SELECT prompt_template FROM tasks WHERE tasks.benchmark_id = benchmarks.id ORDER BY order_index ASC, id ASC LIMIT 1), ''),
        score_type = COALESCE((SELECT score_type FROM tasks WHERE tasks.benchmark_id = benchmarks.id ORDER BY order_index ASC, id ASC LIMIT 1), score_type, 'numeric'),
        expected_answer = COALESCE(expected_answer, (SELECT expected_answer FROM tasks WHERE tasks.benchmark_id = benchmarks.id ORDER BY order_index ASC, id ASC LIMIT 1)),
        pass_condition = COALESCE(pass_condition, (SELECT pass_condition FROM tasks WHERE tasks.benchmark_id = benchmarks.id ORDER BY order_index ASC, id ASC LIMIT 1)),
        evaluation_checklist = COALESCE(NULLIF(evaluation_checklist, '[]'), (SELECT evaluation_checklist FROM tasks WHERE tasks.benchmark_id = benchmarks.id ORDER BY order_index ASC, id ASC LIMIT 1), '[]'),
        attempts = COALESCE((SELECT attempts FROM tasks WHERE tasks.benchmark_id = benchmarks.id ORDER BY order_index ASC, id ASC LIMIT 1), attempts, 1),
        output_type = COALESCE((SELECT output_type FROM tasks WHERE tasks.benchmark_id = benchmarks.id ORDER BY order_index ASC, id ASC LIMIT 1), output_type, 'text'),
        reference_image = COALESCE(reference_image, (SELECT reference_image FROM tasks WHERE tasks.benchmark_id = benchmarks.id ORDER BY order_index ASC, id ASC LIMIT 1))
      WHERE prompt_template IS NULL OR prompt_template = '';
    `)
  }
}

function initDb() {
  if (db) return db

  const dbPath = path.join(getDataPath(), 'benchforge.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  ensureModelsSchema(db)
  db.prepare(`UPDATE models SET mode = 'api' WHERE mode = 'oauth'`).run()
  ensureBenchmarksSchema(db)

  db.exec(`
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
    );
  `)

  ensureResultsSchema(db)
  ensureBenchmarkColumns(db)
  ensureTasksSchema(db)
  removeAutoGeneratedParentTasks(db)
  createDiscoveredModelsTable(db)
  migrateStoredSecrets(db)
  ensureResultArtifacts(db)

  return db
}

function mapDiscoveredModelRow(row) {
  return {
    provider: row.provider,
    modelId: row.model_id,
    baseUrl: row.base_url || null,
    lastSeenAt: row.last_seen_at,
  }
}

function getDiscoveredModels(provider = null) {
  const database = getDb()
  const sql = provider
    ? `SELECT provider, model_id, base_url, last_seen_at FROM discovered_models WHERE provider = ? ORDER BY provider ASC, model_id ASC`
    : `SELECT provider, model_id, base_url, last_seen_at FROM discovered_models ORDER BY provider ASC, model_id ASC`
  const rows = provider ? database.prepare(sql).all(provider) : database.prepare(sql).all()
  return rows.map(mapDiscoveredModelRow)
}

function saveDiscoveredModels(items) {
  const database = getDb()
  const models = Array.isArray(items) ? items.filter((item) => item?.provider && item?.modelId) : []
  if (models.length === 0) return getDiscoveredModels()
  const tx = database.transaction(() => {
    const stmt = database.prepare(`
      INSERT INTO discovered_models (provider, model_id, base_url, last_seen_at)
      VALUES (@provider, @model_id, @base_url, datetime('now'))
      ON CONFLICT(provider, model_id) DO UPDATE SET base_url = excluded.base_url, last_seen_at = datetime('now')
    `)
    for (const model of models) {
      stmt.run({ provider: model.provider, model_id: model.modelId, base_url: model.baseUrl || null })
    }
  })
  tx()
  return getDiscoveredModels()
}

const MODEL_SELECT = `id, name, mode, provider, base_url, api_key, model_id, input_price_per_1m, output_price_per_1m, pricing_source, pricing_model_id, pricing_updated_at, created_at`

function getModels() {
  return getDb().prepare(`SELECT ${MODEL_SELECT} FROM models ORDER BY id DESC`).all().map(mapModelRow)
}

function getModelById(id) {
  const row = getDb().prepare(`SELECT ${MODEL_SELECT} FROM models WHERE id = ?`).get(id)
  return row ? mapModelRow(row) : null
}

function getBenchmarks() {
  return getDb().prepare(`SELECT id, name, category, description, suite_name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, output_type, reference_image, created_at FROM benchmarks ORDER BY id DESC`).all().map(mapBenchmarkRow)
}

function getBenchmarkById(id) {
  const row = getDb().prepare(`SELECT id, name, category, description, suite_name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, output_type, reference_image, created_at FROM benchmarks WHERE id = ?`).get(id)
  return row ? mapBenchmarkRow(row) : null
}

function getTasks(benchmarkId) {
  return getDb().prepare(`SELECT id, benchmark_id, name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, order_index, output_type, reference_image, created_at FROM tasks WHERE benchmark_id = ? ORDER BY order_index ASC, id ASC`).all(benchmarkId).map(mapTaskRow)
}

function getAllTasks() {
  return getDb().prepare(`SELECT id, benchmark_id, name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, order_index, output_type, reference_image, created_at FROM tasks ORDER BY benchmark_id ASC, order_index ASC, id ASC`).all().map(mapTaskRow)
}

function getTaskById(id) {
  const row = getDb().prepare(`SELECT id, benchmark_id, name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, order_index, output_type, reference_image, created_at FROM tasks WHERE id = ?`).get(id)
  return row ? mapTaskRow(row) : null
}

function addModel(data) {
  const normalized = normalizeModelSecretData(data)
  const result = getDb().prepare(`
    INSERT INTO models (name, mode, provider, base_url, api_key, model_id, input_price_per_1m, output_price_per_1m, pricing_source, pricing_model_id, pricing_updated_at)
    VALUES (@name, @mode, @provider, @base_url, @api_key, @model_id, @input_price_per_1m, @output_price_per_1m, @pricing_source, @pricing_model_id, @pricing_updated_at)
  `).run({
    name: normalized.name,
    mode: normalized.mode,
    provider: normalized.provider || null,
    base_url: normalized.base_url || null,
    api_key: normalized.api_key || null,
    model_id: normalized.model_id || null,
    input_price_per_1m: normalized.input_price_per_1m ?? null,
    output_price_per_1m: normalized.output_price_per_1m ?? null,
    pricing_source: normalized.pricing_source || null,
    pricing_model_id: normalized.pricing_model_id || null,
    pricing_updated_at: normalized.pricing_updated_at || null,
  })
  return getModelById(result.lastInsertRowid)
}

function updateModel(id, data) {
  const normalized = normalizeModelSecretData(data)
  const query = buildUpdateQuery('models', {
    name: 'name', mode: 'mode', provider: 'provider', base_url: 'base_url', api_key: 'api_key', model_id: 'model_id',
    input_price_per_1m: 'input_price_per_1m', output_price_per_1m: 'output_price_per_1m', pricing_source: 'pricing_source', pricing_model_id: 'pricing_model_id', pricing_updated_at: 'pricing_updated_at',
  }, id, normalized)
  if (!query) return getModelById(id)
  getDb().prepare(query.sql).run(query.params)
  return getModelById(id)
}

function deleteModel(id) {
  return getDb().prepare(`DELETE FROM models WHERE id = ?`).run(id)
}

function addBenchmark(data) {
  const result = getDb().prepare(`
    INSERT INTO benchmarks (name, category, description, suite_name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, output_type, reference_image)
    VALUES (@name, @category, @description, @suite_name, @prompt_template, @score_type, @expected_answer, @pass_condition, @evaluation_checklist, @evaluation_rubric, @attempts, @output_type, @reference_image)
  `).run({
    name: data.name,
    category: data.category,
    description: data.description || null,
    suite_name: data.suite_name || null,
    prompt_template: data.prompt_template || data.promptTemplate || '',
    score_type: data.score_type || data.scoreType || 'numeric',
    expected_answer: data.expected_answer || data.expectedAnswer || null,
    pass_condition: data.pass_condition || data.passCondition || null,
    evaluation_checklist: JSON.stringify(Array.isArray(data.evaluation_checklist) ? data.evaluation_checklist : Array.isArray(data.evaluationChecklist) ? data.evaluationChecklist : []),
    evaluation_rubric: JSON.stringify(Array.isArray(data.evaluation_rubric) ? data.evaluation_rubric : Array.isArray(data.evaluationRubric) ? data.evaluationRubric : []),
    attempts: data.attempts || 1,
    output_type: data.output_type || data.outputType || 'text',
    reference_image: data.reference_image || data.referenceImage || null,
  })
  return getBenchmarkById(result.lastInsertRowid)
}

function updateBenchmark(id, data) {
  const normalized = { ...data }
  if (Object.prototype.hasOwnProperty.call(normalized, 'evaluationChecklist')) {
    normalized.evaluationChecklist = JSON.stringify(Array.isArray(normalized.evaluationChecklist) ? normalized.evaluationChecklist : [])
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'evaluation_checklist')) {
    normalized.evaluation_checklist = JSON.stringify(Array.isArray(normalized.evaluation_checklist) ? normalized.evaluation_checklist : [])
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'evaluationRubric')) {
    normalized.evaluationRubric = JSON.stringify(Array.isArray(normalized.evaluationRubric) ? normalized.evaluationRubric : [])
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'evaluation_rubric')) {
    normalized.evaluation_rubric = JSON.stringify(Array.isArray(normalized.evaluation_rubric) ? normalized.evaluation_rubric : [])
  }
  const query = buildUpdateQuery('benchmarks', {
    name: 'name', category: 'category', description: 'description', suite_name: 'suite_name',
    prompt_template: 'prompt_template', promptTemplate: 'prompt_template',
    score_type: 'score_type', scoreType: 'score_type',
    expected_answer: 'expected_answer', expectedAnswer: 'expected_answer',
    pass_condition: 'pass_condition', passCondition: 'pass_condition',
    evaluation_checklist: 'evaluation_checklist', evaluationChecklist: 'evaluation_checklist', evaluation_rubric: 'evaluation_rubric', evaluationRubric: 'evaluation_rubric',
    attempts: 'attempts', output_type: 'output_type', outputType: 'output_type', reference_image: 'reference_image', referenceImage: 'reference_image',
  }, id, normalized)
  if (!query) return getBenchmarkById(id)
  getDb().prepare(query.sql).run(query.params)
  return getBenchmarkById(id)
}

function deleteBenchmark(id) {
  return getDb().prepare(`DELETE FROM benchmarks WHERE id = ?`).run(id)
}

function addTask(data) {
  const checklist = JSON.stringify(Array.isArray(data.evaluationChecklist) ? data.evaluationChecklist : [])
  const rubric = JSON.stringify(Array.isArray(data.evaluationRubric) ? data.evaluationRubric : [])
  const result = getDb().prepare(`
    INSERT INTO tasks (benchmark_id, name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, order_index, output_type, reference_image)
    VALUES (@benchmark_id, @name, @prompt_template, @score_type, @expected_answer, @pass_condition, @evaluation_checklist, @evaluation_rubric, @attempts, @order_index, @output_type, @reference_image)
  `).run({
    benchmark_id: data.benchmarkId,
    name: data.name,
    prompt_template: data.promptTemplate,
    score_type: data.scoreType,
    expected_answer: data.expectedAnswer || null,
    pass_condition: data.passCondition || null,
    evaluation_checklist: checklist,
    evaluation_rubric: rubric,
    attempts: data.attempts || 1,
    order_index: data.orderIndex || 0,
    output_type: data.outputType || 'text',
    reference_image: data.referenceImage || null,
  })
  return getTaskById(result.lastInsertRowid)
}

function updateTask(id, data) {
  const normalized = { ...data }
  if (Object.prototype.hasOwnProperty.call(normalized, 'evaluationChecklist')) {
    normalized.evaluation_checklist = JSON.stringify(Array.isArray(normalized.evaluationChecklist) ? normalized.evaluationChecklist : [])
    delete normalized.evaluationChecklist
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'evaluationRubric')) {
    normalized.evaluation_rubric = JSON.stringify(Array.isArray(normalized.evaluationRubric) ? normalized.evaluationRubric : [])
    delete normalized.evaluationRubric
  }
  const query = buildUpdateQuery('tasks', {
    benchmarkId: 'benchmark_id',
    name: 'name',
    promptTemplate: 'prompt_template',
    scoreType: 'score_type',
    expectedAnswer: 'expected_answer',
    passCondition: 'pass_condition',
    evaluation_checklist: 'evaluation_checklist',
    evaluation_rubric: 'evaluation_rubric',
    attempts: 'attempts',
    orderIndex: 'order_index',
    outputType: 'output_type',
    referenceImage: 'reference_image',
  }, id, normalized)
  if (!query) return getTaskById(id)
  getDb().prepare(query.sql).run(query.params)
  return getTaskById(id)
}

function deleteTask(id) {
  const database = getDb()
  const tx = database.transaction((taskId) => {
    database.prepare(`DELETE FROM results WHERE task_id = ?`).run(taskId)
    return database.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId)
  })
  return tx(id)
}

function reorderTasks(benchmarkId, orderedIds) {
  const tx = getDb().transaction(() => {
    const stmt = getDb().prepare(`UPDATE tasks SET order_index = ? WHERE id = ? AND benchmark_id = ?`)
    orderedIds.forEach((taskId, index) => stmt.run(index, taskId, benchmarkId))
  })
  tx()
  return getTasks(benchmarkId)
}

const RESULT_SELECT = `id, model_id, benchmark_id, task_id, run_session_id, score, notes, thinking_notes, response_preview, artifact_path, attempt_number, tokens_used, input_tokens, output_tokens, estimated_cost_usd, duration_ms, run_at`

function getResults() {
  return getDb().prepare(`SELECT ${RESULT_SELECT} FROM results ORDER BY datetime(run_at) DESC, id DESC`).all().map(mapResultRow)
}

function getLatestTaskResult(modelId, benchmarkId, taskId, startedAt = null) {
  const sql = startedAt
    ? `SELECT ${RESULT_SELECT} FROM results WHERE model_id = ? AND benchmark_id = ? AND task_id = ? AND datetime(run_at) >= datetime(?) ORDER BY id DESC LIMIT 1`
    : `SELECT ${RESULT_SELECT} FROM results WHERE model_id = ? AND benchmark_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1`
  const row = startedAt
    ? getDb().prepare(sql).get(modelId, benchmarkId, taskId, startedAt)
    : getDb().prepare(sql).get(modelId, benchmarkId, taskId)
  return row ? mapResultRow(row) : null
}

function writeArtifactsForResult(resultRow) {
  const database = getDb()
  const result = typeof resultRow.id === 'number' ? resultRow : mapResultRow(resultRow)
  const model = getModelById(result.model_id)
  const benchmark = getBenchmarkById(result.benchmark_id)
  if (!benchmark) return result
  const task = result.task_id ? getTaskById(result.task_id) : null
  const benchmarkSnapshot = { ...benchmark, tasks: getTasks(result.benchmark_id) }
  const response_preview = previewText(result.notes)

  try {
    const artifact_path = writeResultArtifacts({ result: { ...result, response_preview }, model, benchmark: benchmarkSnapshot, task })
    database.prepare(`UPDATE results SET artifact_path = ?, response_preview = ? WHERE id = ?`).run(artifact_path, response_preview || null, result.id)
    return mapResultRow(database.prepare(`SELECT ${RESULT_SELECT} FROM results WHERE id = ?`).get(result.id))
  } catch (error) {
    console.warn('[artifacts] Failed to write result artifacts:', error)
    database.prepare(`UPDATE results SET response_preview = ? WHERE id = ?`).run(response_preview || null, result.id)
    return mapResultRow(database.prepare(`SELECT ${RESULT_SELECT} FROM results WHERE id = ?`).get(result.id))
  }
}

function ensureResultArtifacts(database = getDb()) {
  const rows = database.prepare(`SELECT ${RESULT_SELECT} FROM results WHERE artifact_path IS NULL OR artifact_path = '' ORDER BY id ASC`).all()
  for (const row of rows) writeArtifactsForResult(mapResultRow(row))
  return rows.length
}

function estimateResultCost(data) {
  if (data.estimated_cost_usd !== undefined && data.estimated_cost_usd !== null && data.estimated_cost_usd !== '') return Number(data.estimated_cost_usd) || null
  const model = getModelById(data.model_id)
  if (!model) return null
  const inputPrice = Number(model.input_price_per_1m)
  const outputPrice = Number(model.output_price_per_1m)
  if (!Number.isFinite(inputPrice) && !Number.isFinite(outputPrice)) return null

  const inputTokens = Number(data.input_tokens ?? data.inputTokens ?? 0)
  const outputTokens = Number(data.output_tokens ?? data.outputTokens ?? 0)
  if (inputTokens > 0 || outputTokens > 0) {
    const inputCost = inputTokens > 0 && Number.isFinite(inputPrice) ? inputTokens * inputPrice / 1_000_000 : 0
    const outputCost = outputTokens > 0 && Number.isFinite(outputPrice) ? outputTokens * outputPrice / 1_000_000 : 0
    const total = inputCost + outputCost
    return total > 0 ? Number(total.toFixed(8)) : null
  }

  const totalTokens = Number(data.tokens_used ?? data.tokensUsed ?? 0)
  if (totalTokens <= 0) return null
  const fallbackPrice = Number.isFinite(inputPrice) && Number.isFinite(outputPrice)
    ? (inputPrice + outputPrice) / 2
    : Number.isFinite(inputPrice) ? inputPrice : outputPrice
  return Number.isFinite(fallbackPrice) ? Number((totalTokens * fallbackPrice / 1_000_000).toFixed(8)) : null
}

function addResult(data) {
  const response_preview = previewText(data.notes || '') || null
  const estimated_cost_usd = estimateResultCost(data)
  const result = getDb().prepare(`
    INSERT INTO results (model_id, benchmark_id, task_id, run_session_id, score, notes, thinking_notes, response_preview, artifact_path, attempt_number, tokens_used, input_tokens, output_tokens, estimated_cost_usd, duration_ms, run_at)
    VALUES (@model_id, @benchmark_id, @task_id, @run_session_id, @score, @notes, @thinking_notes, @response_preview, @artifact_path, COALESCE(@attempt_number, 1), @tokens_used, @input_tokens, @output_tokens, @estimated_cost_usd, @duration_ms, COALESCE(@run_at, datetime('now')))
  `).run({
    model_id: data.model_id,
    benchmark_id: data.benchmark_id,
    task_id: data.task_id || null,
    run_session_id: data.run_session_id || data.runSessionId || null,
    score: String(data.score),
    notes: data.notes || null,
    thinking_notes: data.thinking_notes || data.thinkingNotes || null,
    response_preview,
    artifact_path: data.artifact_path || data.artifactPath || null,
    attempt_number: data.attempt_number || 1,
    tokens_used: data.tokens_used ?? null,
    input_tokens: data.input_tokens ?? data.inputTokens ?? null,
    output_tokens: data.output_tokens ?? data.outputTokens ?? null,
    estimated_cost_usd,
    duration_ms: data.duration_ms ?? null,
    run_at: data.run_at || null,
  })
  const created = mapResultRow(getDb().prepare(`SELECT ${RESULT_SELECT} FROM results WHERE id = ?`).get(result.lastInsertRowid))
  return writeArtifactsForResult(created)
}

function deleteResult(id) {
  const existing = getDb().prepare(`SELECT artifact_path FROM results WHERE id = ?`).get(id)
  if (existing?.artifact_path) removeArtifact(existing.artifact_path)
  return getDb().prepare(`DELETE FROM results WHERE id = ?`).run(id)
}

function clearResultsData() {
  const database = getDb()
  const tx = database.transaction(() => {
    database.exec(`
      DELETE FROM run_sessions;
      DELETE FROM results;
      DELETE FROM runs;
      DELETE FROM sqlite_sequence WHERE name IN ('results', 'runs', 'run_sessions');
    `)
  })
  tx()
  clearArtifacts()
  return { results: getResults(), runs: getRuns() }
}

function getRuns() {
  return getDb().prepare(`SELECT id, name, started_at, finished_at, status FROM runs ORDER BY datetime(started_at) DESC, id DESC`).all().map(mapRunRow)
}

function addRun(data) {
  const result = getDb().prepare(`INSERT INTO runs (name, started_at, finished_at, status) VALUES (@name, COALESCE(@started_at, datetime('now')), @finished_at, COALESCE(@status, 'pending'))`).run({
    name: data.name || null,
    started_at: data.started_at || data.startedAt || null,
    finished_at: data.finished_at || data.finishedAt || null,
    status: data.status || 'pending',
  })
  return mapRunRow(getDb().prepare(`SELECT id, name, started_at, finished_at, status FROM runs WHERE id = ?`).get(result.lastInsertRowid))
}

function updateRun(id, data) {
  const query = buildUpdateQuery('runs', {
    name: 'name', started_at: 'started_at', startedAt: 'started_at', finished_at: 'finished_at', finishedAt: 'finished_at', status: 'status',
  }, id, data)
  if (!query) return mapRunRow(getDb().prepare(`SELECT id, name, started_at, finished_at, status FROM runs WHERE id = ?`).get(id))
  getDb().prepare(query.sql).run(query.params)
  return mapRunRow(getDb().prepare(`SELECT id, name, started_at, finished_at, status FROM runs WHERE id = ?`).get(id))
}

function createRunSession(data) {
  const result = getDb().prepare(`
    INSERT INTO run_sessions (model_id, benchmark_ids, status, current_benchmark_id, current_task_id, completed_task_ids)
    VALUES (@model_id, @benchmark_ids, COALESCE(@status, 'running'), @current_benchmark_id, @current_task_id, @completed_task_ids)
  `).run({
    model_id: data.model_id,
    benchmark_ids: JSON.stringify(Array.isArray(data.benchmark_ids) ? data.benchmark_ids : []),
    status: data.status || 'running',
    current_benchmark_id: data.current_benchmark_id || null,
    current_task_id: data.current_task_id || null,
    completed_task_ids: JSON.stringify(Array.isArray(data.completed_task_ids) ? data.completed_task_ids : []),
  })
  return getRunSession(result.lastInsertRowid)
}

function getRunSession(id) {
  return mapRunSessionRow(getDb().prepare(`SELECT * FROM run_sessions WHERE id = ?`).get(id))
}

function getActiveRunSession() {
  return mapRunSessionRow(getDb().prepare(`SELECT * FROM run_sessions WHERE status IN ('running', 'interrupted') ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1`).get())
}

function updateRunSession(id, data) {
  const payload = { ...data }
  if (Object.prototype.hasOwnProperty.call(payload, 'benchmark_ids')) payload.benchmark_ids = JSON.stringify(Array.isArray(payload.benchmark_ids) ? payload.benchmark_ids : [])
  if (Object.prototype.hasOwnProperty.call(payload, 'completed_task_ids')) payload.completed_task_ids = JSON.stringify(Array.isArray(payload.completed_task_ids) ? payload.completed_task_ids : [])

  const query = buildUpdateQuery('run_sessions', {
    model_id: 'model_id',
    benchmark_ids: 'benchmark_ids',
    status: 'status',
    current_benchmark_id: 'current_benchmark_id',
    current_task_id: 'current_task_id',
    completed_task_ids: 'completed_task_ids',
  }, id, payload)
  if (query) getDb().prepare(`${query.sql.replace(' WHERE id = @id', '')}, updated_at = datetime('now') WHERE id = @id`).run(query.params)
  else getDb().prepare(`UPDATE run_sessions SET updated_at = datetime('now') WHERE id = ?`).run(id)
  return getRunSession(id)
}

function finishRunSession(id) {
  return updateRunSession(id, { status: 'finished', current_task_id: null })
}

function cancelRunSession(id) {
  return updateRunSession(id, { status: 'cancelled', current_task_id: null })
}

function interruptActiveRunSessions() {
  return getDb().prepare(`UPDATE run_sessions SET status = 'interrupted', updated_at = datetime('now') WHERE status = 'running'`).run()
}

function getAllData() {
  return {
    models: getModels().map((model) => ({ ...model, api_key: null })),
    benchmarks: getBenchmarks(),
    tasks: getAllTasks(),
    results: getResults(),
    runs: getRuns(),
  }
}

function clearAllData() {
  const database = getDb()
  const tx = database.transaction(() => {
    database.exec(`
      DELETE FROM run_sessions;
      DELETE FROM results;
      DELETE FROM runs;
      DELETE FROM tasks;
      DELETE FROM benchmarks;
      DELETE FROM discovered_models;
      DELETE FROM models;
      DELETE FROM sqlite_sequence WHERE name IN ('models', 'benchmarks', 'tasks', 'results', 'runs', 'run_sessions');
    `)
  })
  tx()
  clearArtifacts()
  return getAllData()
}

function replaceAllData(data) {
  const database = getDb()
  const payload = {
    models: Array.isArray(data?.models) ? data.models : [],
    benchmarks: Array.isArray(data?.benchmarks) ? data.benchmarks : [],
    results: Array.isArray(data?.results) ? data.results : [],
    runs: Array.isArray(data?.runs) ? data.runs : [],
  }

  const tx = database.transaction(() => {
    database.exec(`
      DELETE FROM results;
      DELETE FROM tasks;
      DELETE FROM runs;
      DELETE FROM run_sessions;
      DELETE FROM benchmarks;
      DELETE FROM discovered_models;
      DELETE FROM models;
      DELETE FROM sqlite_sequence WHERE name IN ('models', 'benchmarks', 'tasks', 'results', 'runs', 'run_sessions');
    `)

    const insertModel = database.prepare(`INSERT INTO models (id, name, mode, provider, base_url, api_key, model_id, input_price_per_1m, output_price_per_1m, pricing_source, pricing_model_id, pricing_updated_at, created_at) VALUES (@id, @name, @mode, @provider, @base_url, @api_key, @model_id, @input_price_per_1m, @output_price_per_1m, @pricing_source, @pricing_model_id, @pricing_updated_at, COALESCE(@created_at, datetime('now')))`)
    const insertBenchmark = database.prepare(`INSERT INTO benchmarks (id, name, category, description, suite_name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, output_type, reference_image, created_at) VALUES (@id, @name, @category, @description, @suite_name, @prompt_template, @score_type, @expected_answer, @pass_condition, @evaluation_checklist, @evaluation_rubric, @attempts, @output_type, @reference_image, COALESCE(@created_at, datetime('now')))`)
    const insertTask = database.prepare(`INSERT INTO tasks (id, benchmark_id, name, prompt_template, score_type, expected_answer, pass_condition, evaluation_checklist, evaluation_rubric, attempts, order_index, output_type, reference_image, created_at) VALUES (@id, @benchmark_id, @name, @prompt_template, @score_type, @expected_answer, @pass_condition, @evaluation_checklist, @evaluation_rubric, @attempts, @order_index, @output_type, @reference_image, COALESCE(@created_at, datetime('now')))`)
    const insertResult = database.prepare(`INSERT INTO results (id, model_id, benchmark_id, task_id, run_session_id, score, notes, thinking_notes, response_preview, artifact_path, attempt_number, tokens_used, input_tokens, output_tokens, estimated_cost_usd, duration_ms, run_at) VALUES (@id, @model_id, @benchmark_id, @task_id, @run_session_id, @score, @notes, @thinking_notes, @response_preview, @artifact_path, COALESCE(@attempt_number, 1), @tokens_used, @input_tokens, @output_tokens, @estimated_cost_usd, @duration_ms, COALESCE(@run_at, datetime('now')))`)
    const insertRun = database.prepare(`INSERT INTO runs (id, name, started_at, finished_at, status) VALUES (@id, @name, COALESCE(@started_at, datetime('now')), @finished_at, COALESCE(@status, 'pending'))`)

    for (const model of payload.models) insertModel.run({
      ...model,
      mode: model.mode || 'api',
      provider: model.provider || null,
      base_url: model.base_url || null,
      api_key: model.api_key ? encryptSecret(model.api_key) : null,
      model_id: model.model_id || null,
      input_price_per_1m: model.input_price_per_1m ?? null,
      output_price_per_1m: model.output_price_per_1m ?? null,
      pricing_source: model.pricing_source || null,
      pricing_model_id: model.pricing_model_id || null,
      pricing_updated_at: model.pricing_updated_at || null,
      created_at: model.created_at || null,
    })
    for (const benchmark of payload.benchmarks) insertBenchmark.run({
      ...benchmark,
      suite_name: benchmark.suite_name || null,
      prompt_template: benchmark.prompt_template || '',
      score_type: benchmark.score_type || 'numeric',
      expected_answer: benchmark.expected_answer || null,
      pass_condition: benchmark.pass_condition || null,
      evaluation_checklist: JSON.stringify(Array.isArray(benchmark.evaluation_checklist) ? benchmark.evaluation_checklist : []),
      evaluation_rubric: JSON.stringify(Array.isArray(benchmark.evaluation_rubric) ? benchmark.evaluation_rubric : []),
      attempts: benchmark.attempts || 1,
      output_type: benchmark.output_type || 'text',
      reference_image: benchmark.reference_image || null,
      created_at: benchmark.created_at || null,
    })
    for (const task of (Array.isArray(data?.tasks) ? data.tasks : [])) insertTask.run({
      ...task,
      evaluation_checklist: JSON.stringify(Array.isArray(task.evaluation_checklist) ? task.evaluation_checklist : []),
      evaluation_rubric: JSON.stringify(Array.isArray(task.evaluation_rubric) ? task.evaluation_rubric : []),
      expected_answer: task.expected_answer || null,
      attempts: task.attempts || 1,
      output_type: task.output_type || 'text',
      reference_image: task.reference_image || null,
      created_at: task.created_at || null,
    })
    for (const result of payload.results) insertResult.run({
      ...result,
      run_session_id: null,
      attempt_number: result.attempt_number || 1,
      thinking_notes: result.thinking_notes || null,
      response_preview: result.response_preview || previewText(result.notes) || null,
      artifact_path: null,
      tokens_used: result.tokens_used ?? null,
      input_tokens: result.input_tokens ?? null,
      output_tokens: result.output_tokens ?? null,
      estimated_cost_usd: result.estimated_cost_usd ?? null,
      duration_ms: result.duration_ms ?? null,
      run_at: result.run_at || null,
    })
    for (const run of payload.runs) insertRun.run({
      ...run,
      started_at: run.started_at || null,
      finished_at: run.finished_at || null,
    })
  })

  tx()
  clearArtifacts()
  ensureResultArtifacts(database)
  return getAllData()
}

// ============================================================
// Preferences (UI settings persisted to SQLite)
// ============================================================
function savePreference(key, value) {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO preferences (key, value) VALUES (@key, @value)
  `)
  stmt.run({ key, value: serializePreferenceValue(key, value) })
}

function getPreference(key) {
  const database = getDb()
  const row = database.prepare('SELECT value FROM preferences WHERE key = ?').get(key)
  if (!row || row.value === null) return undefined
  try {
    return deserializePreferenceValue(key, row.value)
  } catch {
    return SECRET_PREFERENCE_KEYS.has(key) ? decryptSecret(row.value) : row.value
  }
}

module.exports = {
  initDb,
  getModels,
  getModelById,
  getDiscoveredModels,
  saveDiscoveredModels,
  getBenchmarks,
  getBenchmarkById,
  getTasks,
  getAllTasks,
  getTaskById,
  addModel,
  updateModel,
  deleteModel,
  addBenchmark,
  updateBenchmark,
  deleteBenchmark,
  addTask,
  updateTask,
  deleteTask,
  reorderTasks,
  getResults,
  getLatestTaskResult,
  ensureResultArtifacts,
  addResult,
  deleteResult,
  clearResultsData,
  getRuns,
  addRun,
  updateRun,
  createRunSession,
  getRunSession,
  getActiveRunSession,
  updateRunSession,
  finishRunSession,
  cancelRunSession,
  interruptActiveRunSessions,
  getAllData,
  clearAllData,
  replaceAllData,

  // Preferences (UI settings)
  savePreference,
  getPreference,
}
