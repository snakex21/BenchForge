const path = require('path')
const fs = require('fs/promises')
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const {
  initDb,
  getModels,
  getModelById,
  getDiscoveredModels,
  saveDiscoveredModels,
  getBenchmarkById,
  getTasks,
  getTaskById,
  addModel,
  updateModel,
  deleteModel,
  getBenchmarks,
  addBenchmark,
  updateBenchmark,
  deleteBenchmark,
  addTask,
  updateTask,
  deleteTask,
  reorderTasks,
  getResults,
  ensureResultArtifacts,
  addResult,
  deleteResult,
  clearResultsData,
  getRuns,
  addRun,
  updateRun,
  createRunSession,
  getActiveRunSession,
  updateRunSession,
  finishRunSession,
  cancelRunSession,
  interruptActiveRunSessions,
  getAllData,
  clearAllData,
  replaceAllData,
  savePreference,
  getPreference,
} = require('./database.cjs')
const { resolveArtifactPath, zipDirectory } = require('./artifacts.cjs')
const { checkEnvironment } = require('./systemTools.cjs')
const { getProvider } = require('./providers/index.cjs')
const { runBenchmark, runBenchmarkStreaming, submitManualBatch } = require('./runner.cjs')
const { listBenchmarkPacks, downloadBenchmarkPack } = require('./benchmarkLibrary.cjs')
const { scanBenchmarkBeacon, discoverBenchmarkBeacons } = require('./benchmarkRadar.cjs')
const { listTools, runTool } = require('./toolRuntime.cjs')
const { listMcpTools, callMcpTool } = require('./mcpRuntime.cjs')
const { getSecretStoreStatus } = require('./secretStore.cjs')
const { getDataPath } = require('./paths.cjs')
const { DEFAULT_REPO: UPDATE_REPO, downloadLatestAsset, getLatestRelease } = require('./updateChecker.cjs')
const { applyPortableUpdate } = require('./portableUpdater.cjs')

const rendererUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL || ''
const isDev = Boolean(rendererUrl)
let mainWindow = null
let currentBenchmarkAbort = null

function getGithubTokenPreference() {
  return String(getPreference('github_token') || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim() || null
}

async function getHealthCheck() {
  const environment = await checkEnvironment()
  const models = getModels()
  const apiModels = models.filter((model) => model.mode === 'api')
  const localProviders = new Set(['lmstudio', 'ollama', 'liquid-ai'])
  const remoteApiModels = apiModels.filter((model) => model.provider && !localProviders.has(model.provider))
  const missingKeyModels = remoteApiModels.filter((model) => !String(model.api_key || '').trim())
  const mcpServers = getPreference('mcp_servers') || []
  const repoSandboxRoots = getPreference('repo_sandbox_roots') || []
  const judgeModelId = getPreference('judge_model_id')
  const githubToken = getGithubTokenPreference()
  const secretStore = getSecretStoreStatus()
  const dockerCheck = environment.checks.find((check) => check.label === 'Docker')
  const sandboxUseDocker = Boolean(getPreference('sandbox_use_docker'))

  const checks = [
    ...environment.checks.map((check) => ({ ...check, group: 'environment' })),
    {
      label: 'Secret Store',
      group: 'security',
      ok: secretStore.ok,
      required: false,
      version: secretStore.backend,
      error: secretStore.ok ? null : 'Electron safeStorage unavailable; secrets use insecure fallback encoding.',
    },
    {
      label: 'API keys',
      group: 'models',
      ok: missingKeyModels.length === 0,
      required: false,
      version: remoteApiModels.length === 0 ? 'No remote API models configured' : `${remoteApiModels.length - missingKeyModels.length}/${remoteApiModels.length} remote API model keys present`,
      error: missingKeyModels.length ? `Missing keys: ${missingKeyModels.map((model) => model.name).join(', ')}` : null,
    },
    {
      label: 'Local model runtimes',
      group: 'models',
      ok: apiModels.some((model) => localProviders.has(model.provider)) || models.some((model) => model.mode === 'manual'),
      required: false,
      version: apiModels.some((model) => localProviders.has(model.provider)) ? 'Local runtime model configured' : models.some((model) => model.mode === 'manual') ? 'Manual model configured' : 'No local/manual model configured',
    },
    {
      label: 'Docker sandbox preference',
      group: 'sandbox',
      ok: !sandboxUseDocker || Boolean(dockerCheck?.ok),
      required: false,
      version: sandboxUseDocker ? 'Docker sandbox enabled' : 'Docker sandbox disabled',
      error: sandboxUseDocker && !dockerCheck?.ok ? 'Docker sandbox is enabled but Docker is unavailable.' : null,
    },
    {
      label: 'MCP servers',
      group: 'mcp',
      ok: Array.isArray(mcpServers) && mcpServers.length > 0,
      required: false,
      version: `${Array.isArray(mcpServers) ? mcpServers.length : 0} configured`,
    },
    {
      label: 'Repo Sandbox',
      group: 'sandbox',
      ok: Array.isArray(repoSandboxRoots) && repoSandboxRoots.length > 0,
      required: false,
      version: `${Array.isArray(repoSandboxRoots) ? repoSandboxRoots.length : 0} repo roots configured`,
    },
    {
      label: 'Judge model',
      group: 'judge',
      ok: typeof judgeModelId === 'number' && models.some((model) => model.id === judgeModelId),
      required: false,
      version: typeof judgeModelId === 'number' ? `Model #${judgeModelId}` : 'Not configured',
    },
    {
      label: 'GitHub Radar token',
      group: 'radar',
      ok: Boolean(githubToken),
      required: false,
      version: githubToken ? 'Configured' : 'Not configured',
    },
  ]

  return { ok: checks.filter((check) => check.required).every((check) => check.ok), checks }
}

const DEFAULT_SCAN_ENDPOINTS = [
  { key: 'lmstudio', name: 'LMStudio', url: 'http://localhost:1234/v1', type: 'openai' },
  { key: 'ollama', name: 'Ollama', url: 'http://localhost:11434', type: 'ollama' },
]

function normalizeScanUrl(url, suffix) {
  if (!suffix) return String(url || '').replace(/\/$/, '')
  let trimmed = String(url || '').replace(/\/$/, '')
  if (suffix === '/api/tags') trimmed = trimmed.replace(/\/v1$/i, '')
  if (trimmed.endsWith('/models') || trimmed.endsWith('/api/tags')) return trimmed
  return `${trimmed}${suffix}`
}

async function fetchJsonWithTimeout(url, timeoutMs = 3000, headers = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function scanEndpoint(endpoint) {
  const key = endpoint.key || String(endpoint.name || '').toLowerCase() || 'custom'
  const isOllama = endpoint.type === 'ollama' || /ollama/i.test(endpoint.name || '') || /11434/.test(endpoint.url || '')
  if (endpoint.scanUnsupported) return { key, models: [] }
  if (endpoint.requiresApiKey && !endpoint.apiKey) return { key, models: [], skipped: 'brak API key' }
  let url = normalizeScanUrl(endpoint.url, endpoint.scanPath || (isOllama ? '/api/tags' : '/models'))
  const headers = {}
  if (endpoint.apiKey) {
    if (endpoint.authType === 'anthropic') {
      headers['x-api-key'] = endpoint.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (endpoint.authType === 'google') {
      headers['x-goog-api-key'] = endpoint.apiKey
      url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(endpoint.apiKey)}`
    } else {
      headers.Authorization = `Bearer ${endpoint.apiKey}`
    }
  }
  const payload = await fetchJsonWithTimeout(url, 3000, headers)

  if (isOllama) {
    return { key, models: Array.isArray(payload?.models) ? payload.models.map((model) => model?.name).filter(Boolean) : [] }
  }

  if (Array.isArray(payload?.data)) return { key, models: payload.data.map((model) => model?.id || model?.name).filter(Boolean) }
  if (Array.isArray(payload?.models)) return { key, models: payload.models.map((model) => String(model?.id || model?.name || model).replace(/^models\//, '')).filter(Boolean) }
  return { key, models: [] }
}

function createMainWindow() {
  const win = new BrowserWindow({
    title: 'BenchForge',
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow = win

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
    console.error(`[did-fail-load] ${errorCode} ${errorDescription} ${validatedURL}`)
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  win.webContents.setBackgroundThrottling(false)

  if (isDev) {
    win.loadURL(rendererUrl)
    return
  }

  win.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'))
}

ipcMain.handle('app:get-meta', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  dataPath: getDataPath(),
}))

ipcMain.handle('app:get-data-path', () => getDataPath())
ipcMain.handle('app:open-data-path', async () => {
  const error = await shell.openPath(getDataPath())
  return { ok: !error, error: error || null }
})
ipcMain.handle('app:open-external', async (_, url) => {
  const target = String(url || '')
  if (!/^https:\/\//i.test(target)) return { ok: false, error: 'Only HTTPS URLs are allowed.' }
  await shell.openExternal(target)
  return { ok: true, error: null }
})
ipcMain.handle('updates:check', async (_, payload) => getLatestRelease({ repo: payload?.repo || UPDATE_REPO, token: getGithubTokenPreference(), currentVersion: app.getVersion() }))
ipcMain.handle('updates:download', async (_, payload) => downloadLatestAsset({ repo: payload?.repo || UPDATE_REPO, token: getGithubTokenPreference(), currentVersion: app.getVersion(), assetName: payload?.assetName || null, kind: payload?.kind || 'zip' }))
ipcMain.handle('updates:apply-portable', async (_, payload) => applyPortableUpdate({ repo: payload?.repo || UPDATE_REPO, token: getGithubTokenPreference(), currentVersion: app.getVersion(), assetName: payload?.assetName || null }))

ipcMain.handle('files:save-json', async (_, payload) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Eksportuj wyniki BenchForge',
    defaultPath: payload?.defaultFileName || `benchforge-results-${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })

  if (canceled || !filePath) {
    return { canceled: true }
  }

  await fs.writeFile(filePath, payload?.content ?? '', 'utf-8')
  return { canceled: false, filePath }
})

ipcMain.handle('files:save-text', async (_, payload) => {
  const ext = payload?.extension || 'txt'
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Zapisz odpowiedź modelu',
    defaultPath: payload?.defaultFileName || `benchforge-output.${ext}`,
    filters: [{ name: payload?.extensionLabel || 'Plik', extensions: [ext] }],
  })

  if (canceled || !filePath) {
    return { canceled: true }
  }

  await fs.writeFile(filePath, payload?.content ?? '', 'utf-8')
  return { canceled: false, filePath }
})

ipcMain.handle('files:open-json', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Importuj dane BenchForge',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })

  if (canceled || !filePaths[0]) {
    return { canceled: true }
  }

  const filePath = filePaths[0]
  const content = await fs.readFile(filePath, 'utf-8')
  return { canceled: false, filePath, content }
})

ipcMain.handle('files:open-path', async (_, relativePath) => {
  const absolutePath = resolveArtifactPath(relativePath)
  if (!absolutePath) return { ok: false, error: 'Nieprawidłowa ścieżka artefaktu.' }
  const error = await shell.openPath(absolutePath)
  return { ok: !error, error: error || null }
})

ipcMain.handle('files:export-artifact-zip', async (_, payload) => {
  const relativePath = payload?.relativePath
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Eksportuj artefakty BenchForge',
    defaultPath: payload?.defaultFileName || `benchforge-artifacts-${Date.now()}.zip`,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  })
  if (canceled || !filePath) return { canceled: true }
  const result = zipDirectory(relativePath, filePath)
  return { canceled: false, filePath, files: result.files }
})

ipcMain.handle('benchmark-library:list', () => listBenchmarkPacks())
ipcMain.handle('benchmark-library:download', (_, payload) => downloadBenchmarkPack(payload?.id, payload || {}))
ipcMain.handle('benchmark-radar:scan', (_, payload) => scanBenchmarkBeacon({ ...(payload || {}), token: getGithubTokenPreference() }))
ipcMain.handle('benchmark-radar:discover', (_, payload) => discoverBenchmarkBeacons({ ...(payload || {}), token: getGithubTokenPreference() }))
ipcMain.handle('tools:list', () => listTools())
ipcMain.handle('tools:run', (_, payload) => runTool({ ...(payload || {}), mcpServers: getPreference('mcp_servers') || [] }))
ipcMain.handle('env:check', () => checkEnvironment())
ipcMain.handle('health:check', () => getHealthCheck())
ipcMain.handle('mcp:servers:get', () => getPreference('mcp_servers') || [])
ipcMain.handle('mcp:servers:save', (_, payload) => { savePreference('mcp_servers', Array.isArray(payload?.servers) ? payload.servers : []); return getPreference('mcp_servers') || [] })
ipcMain.handle('mcp:tools:list', () => listMcpTools(getPreference('mcp_servers') || []))
ipcMain.handle('mcp:tool:call', (_, payload) => callMcpTool(getPreference('mcp_servers') || [], payload?.serverId, payload?.toolName, payload?.arguments || {}))

ipcMain.handle('db:models:get', () => getModels())
ipcMain.handle('db:models:add', (_, payload) => addModel(payload))
ipcMain.handle('db:models:update', (_, payload) => updateModel(payload.id, payload.data))
ipcMain.handle('db:models:delete', (_, payload) => deleteModel(payload.id))
ipcMain.handle('db:discovered-models:get', (_, payload) => getDiscoveredModels(payload?.provider || null))

ipcMain.handle('db:benchmarks:get', () => getBenchmarks())
ipcMain.handle('db:benchmarks:add', (_, payload) => addBenchmark(payload))
ipcMain.handle('db:benchmarks:update', (_, payload) => updateBenchmark(payload.id, payload.data))
ipcMain.handle('db:benchmarks:delete', (_, payload) => deleteBenchmark(payload.id))

ipcMain.handle('db:tasks:get', (_, payload) => getTasks(payload.benchmarkId))
ipcMain.handle('db:tasks:add', (_, payload) => addTask(payload))
ipcMain.handle('db:tasks:update', (_, payload) => updateTask(payload.id, payload.data))
ipcMain.handle('db:tasks:delete', (_, payload) => deleteTask(payload.id))
ipcMain.handle('db:tasks:reorder', (_, payload) => reorderTasks(payload.benchmarkId, payload.orderedIds))

ipcMain.handle('db:results:get', () => getResults())
ipcMain.handle('db:results:add', (_, payload) => addResult(payload))
ipcMain.handle('db:results:delete', (_, payload) => deleteResult(payload.id))
ipcMain.handle('db:results:clear', () => clearResultsData())
ipcMain.handle('db:results:rebuild-artifacts', () => ({ created: ensureResultArtifacts() }))

ipcMain.handle('db:runs:get', () => getRuns())
ipcMain.handle('db:runs:add', (_, payload) => addRun(payload))
ipcMain.handle('db:runs:update', (_, payload) => updateRun(payload.id, payload.data))

ipcMain.handle('run-session:create', (_, payload) => createRunSession(payload))
ipcMain.handle('run-session:get-active', () => getActiveRunSession())
ipcMain.handle('run-session:update', (_, payload) => updateRunSession(payload.id, payload.data))
ipcMain.handle('run-session:finish', (_, payload) => finishRunSession(payload.id))
ipcMain.handle('run-session:cancel', (_, payload) => cancelRunSession(payload.id))

ipcMain.handle('db:export-all', () => getAllData())
ipcMain.handle('db:clear-all', () => clearAllData())
ipcMain.handle('db:import-all', (_, payload) => replaceAllData(payload))

ipcMain.handle('db:preference:set', (_, key, value) => savePreference(key, value))
ipcMain.handle('db:preference:get', (_, key) => getPreference(key))

ipcMain.handle('model:test-connection', async (_, payload) => {
  const model = payload?.modelId ? getModelById(payload.modelId) : payload?.modelConfig
  if (!model) {
    return { ok: false, error: 'Nie znaleziono konfiguracji modelu.' }
  }

  const provider = getProvider(model.mode)
  return provider.testConnection(model)
})

ipcMain.handle('judge:evaluate', async (_, payload) => {
  try {
    const model = getModelById(payload?.modelId)
    if (!model) return { ok: false, error: 'Nie znaleziono modelu judge.' }
    const provider = getProvider(model.mode)
    const prompt = `Oceń odpowiedź modelu jako judge. Zwróć WYŁĄCZNIE JSON: {"score":0-100,"passed":true/false,"reason":"..."}.\n\nBenchmark/task:\n${payload?.taskPrompt || ''}\n\nChecklist:\n${Array.isArray(payload?.checklist) ? payload.checklist.map((item) => `- ${item}`).join('\n') : ''}\n\nOdpowiedź oceniana:\n${payload?.response || ''}`
    const result = await provider.sendPrompt(model, prompt)
    let parsed = null
    try {
      const match = String(result.response || '').match(/\{[\s\S]*\}/)
      parsed = JSON.parse(match ? match[0] : result.response)
    } catch {}
    return { ok: true, raw: result.response, tokens_used: result.tokens_used, result: parsed || { score: null, passed: null, reason: result.response } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('models:scan', async (_, payload) => {
  const endpoints = Array.isArray(payload?.endpoints) && payload.endpoints.length > 0
    ? payload.endpoints.map((endpoint) => ({
      key: endpoint.key || String(endpoint.name || '').toLowerCase(),
      name: endpoint.name,
      url: endpoint.url,
      type: endpoint.type,
      apiKey: endpoint.apiKey,
      scanPath: endpoint.scanPath,
      authType: endpoint.authType,
      scanUnsupported: endpoint.scanUnsupported,
      requiresApiKey: endpoint.requiresApiKey,
    }))
    : DEFAULT_SCAN_ENDPOINTS

  const result = { lmstudio: [], ollama: [], errors: {} }

  await Promise.all(endpoints.map(async (endpoint) => {
    const key = endpoint.key || String(endpoint.name || '').toLowerCase()
    try {
      console.log(`[models:scan] Start: ${endpoint.name || key} (${endpoint.url})`)
      const scanned = await scanEndpoint(endpoint)
      if (scanned.skipped) {
        result[scanned.key] = result[scanned.key] || []
        console.log(`[models:scan] SKIP: ${endpoint.name || key} - ${scanned.skipped}`)
        return
      }
      result[scanned.key] = scanned.models
      saveDiscoveredModels(scanned.models.map((modelId) => ({ provider: scanned.key, modelId, baseUrl: endpoint.url })))
      console.log(`[models:scan] OK: ${endpoint.name || key} - ${scanned.models.length} model(i)`)
    } catch (error) {
      result[key] = result[key] || []
      result.errors[key] = error instanceof Error ? error.message : 'Nieznany błąd skanowania.'
      console.warn(`[models:scan] FAIL: ${endpoint.name || key} - ${result.errors[key]}`)
    }
  }))

  for (const item of getDiscoveredModels()) {
    result[item.provider] = Array.from(new Set([...(Array.isArray(result[item.provider]) ? result[item.provider] : []), item.modelId]))
  }

  return result
})

ipcMain.handle('model:send-prompt', async (_, payload) => {
  const model = getModelById(payload?.modelId)
  if (!model) {
    throw new Error('Nie znaleziono modelu.')
  }

  const provider = getProvider(model.mode)
  const result = await provider.sendPrompt(model, payload.prompt)
  return {
    response: result.response,
    tokens_used: result.tokens_used,
    is_manual: result.response === '__MANUAL__',
  }
})

ipcMain.handle('benchmark:run', async (_, payload) => {
  try {
    return await runBenchmark(payload.modelId, payload.benchmarkId)
  } catch (error) {
    return {
      score: null,
      response: null,
      tokens_used: null,
      is_manual: false,
      error: error instanceof Error ? error.message : 'Nieznany błąd benchmark:run',
    }
  }
})

ipcMain.handle('benchmark:run-streaming', async (_, payload) => {
  try {
    if (!mainWindow) {
      return { started: false, error: 'Okno aplikacji nie jest dostępne.' }
    }

    if (currentBenchmarkAbort) {
      return { started: false, error: 'Benchmark jest już uruchomiony.' }
    }
    currentBenchmarkAbort = new AbortController()

    const sendEvent = (eventName, eventPayload) => {
      mainWindow?.webContents.send(eventName, eventPayload)
    }

    void runBenchmarkStreaming(payload.modelId, payload.benchmarkId, sendEvent, currentBenchmarkAbort.signal, payload.sessionId || null, Array.isArray(payload.taskIds) ? payload.taskIds : null).finally(() => {
      currentBenchmarkAbort = null
    })
    return { started: true }
  } catch (error) {
    return { started: false, error: error instanceof Error ? error.message : 'Nieznany błąd benchmark:run-streaming' }
  }
})

ipcMain.handle('benchmark:abort', () => {
  currentBenchmarkAbort?.abort()
  mainWindow?.webContents.send('benchmark:aborted', {})
  return { ok: true }
})

ipcMain.handle('benchmark:submit-manual', async (_, payload) => {
  try {
    const benchmark = getBenchmarkById(payload.benchmarkId)
    if (!benchmark) {
      return { ok: false, resultId: null, error: 'Nie znaleziono benchmarku.' }
    }

    const result = addResult({
      model_id: payload.modelId,
      benchmark_id: payload.benchmarkId,
      task_id: payload.taskId || null,
      run_session_id: payload.runSessionId || payload.sessionId || null,
      score: payload.score,
      notes: payload.response,
      thinking_notes: payload.thinkingNotes || payload.thinking_notes || null,
    })

    return { ok: true, resultId: result.id, error: null }
  } catch (error) {
    return {
      ok: false,
      resultId: null,
      error: error instanceof Error ? error.message : 'Nieznany błąd benchmark:submit-manual',
    }
  }
})

ipcMain.handle('benchmark:submit-manual-streaming', async (_, payload) => {
  try {
    const task = payload.taskId ? getTaskById(payload.taskId) : null
    const benchmarkId = payload.benchmarkId || task?.benchmark_id
    if (!benchmarkId) {
      return { ok: false, resultId: null, error: 'Nie znaleziono benchmarku dla zadania manualnego.' }
    }

    const result = addResult({
      model_id: payload.modelId,
      benchmark_id: benchmarkId,
      task_id: payload.taskId || null,
      run_session_id: payload.runSessionId || payload.sessionId || null,
      score: payload.score,
      notes: payload.response,
      thinking_notes: payload.thinkingNotes || payload.thinking_notes || null,
      attempt_number: payload.attemptNumber || 1,
      tokens_used: payload.tokensUsed ?? payload.tokens_used ?? null,
      duration_ms: payload.durationMs ?? payload.duration_ms ?? null,
    })

    mainWindow?.webContents.send('task:done', {
      benchmarkId,
      taskId: payload.taskId || null,
      score: payload.score,
      response: payload.response,
      attemptNumber: payload.attemptNumber || 1,
      is_manual: true,
      resultId: result.id,
    })

    return { ok: true, resultId: result.id, error: null }
  } catch (error) {
    return {
      ok: false,
      resultId: null,
      error: error instanceof Error ? error.message : 'Nieznany błąd benchmark:submit-manual-streaming',
    }
  }
})

ipcMain.handle('benchmark:submit-manual-batch', async (_, payload) => submitManualBatch(payload))

app.whenReady().then(() => {
  initDb()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  try {
    interruptActiveRunSessions()
  } catch (error) {
    console.error('[run_sessions] Failed to mark active sessions interrupted:', error)
  }
})
