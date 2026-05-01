const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('benchforge', {
  getMeta: () => ipcRenderer.invoke('app:get-meta'),
  getDataPath: () => ipcRenderer.invoke('app:get-data-path'),
  openDataPath: () => ipcRenderer.invoke('app:open-data-path'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  checkForUpdates: (payload) => ipcRenderer.invoke('updates:check', payload),
  downloadUpdate: (payload) => ipcRenderer.invoke('updates:download', payload),
  applyPortableUpdate: (payload) => ipcRenderer.invoke('updates:apply-portable', payload),
  getPricingStatus: () => ipcRenderer.invoke('pricing:status'),
  refreshOpenRouterPricing: () => ipcRenderer.invoke('pricing:refresh-openrouter'),
  saveJsonFile: (payload) => ipcRenderer.invoke('files:save-json', payload),
  saveTextFile: (payload) => ipcRenderer.invoke('files:save-text', payload),
  openJsonFile: () => ipcRenderer.invoke('files:open-json'),
  openPath: (relativePath) => ipcRenderer.invoke('files:open-path', relativePath),
  exportArtifactZip: (payload) => ipcRenderer.invoke('files:export-artifact-zip', payload),
  listBenchmarkPacks: () => ipcRenderer.invoke('benchmark-library:list'),
  downloadBenchmarkPack: (payload) => ipcRenderer.invoke('benchmark-library:download', payload),
  scanBenchmarkBeacon: (payload) => ipcRenderer.invoke('benchmark-radar:scan', payload),
  discoverBenchmarkBeacons: (payload) => ipcRenderer.invoke('benchmark-radar:discover', payload),
  listTools: () => ipcRenderer.invoke('tools:list'),
  runTool: (payload) => ipcRenderer.invoke('tools:run', payload),
  checkEnvironment: () => ipcRenderer.invoke('env:check'),
  healthCheck: () => ipcRenderer.invoke('health:check'),
  getMcpServers: () => ipcRenderer.invoke('mcp:servers:get'),
  saveMcpServers: (servers) => ipcRenderer.invoke('mcp:servers:save', { servers }),
  listMcpTools: () => ipcRenderer.invoke('mcp:tools:list'),
  callMcpTool: (payload) => ipcRenderer.invoke('mcp:tool:call', payload),
  judgeEvaluate: (payload) => ipcRenderer.invoke('judge:evaluate', payload),
})

contextBridge.exposeInMainWorld('db', {
  getModels: () => ipcRenderer.invoke('db:models:get'),
  addModel: (payload) => ipcRenderer.invoke('db:models:add', payload),
  updateModel: (payload) => ipcRenderer.invoke('db:models:update', payload),
  deleteModel: (payload) => ipcRenderer.invoke('db:models:delete', payload),
  getDiscoveredModels: (payload) => ipcRenderer.invoke('db:discovered-models:get', payload),
  getBenchmarks: () => ipcRenderer.invoke('db:benchmarks:get'),
  addBenchmark: (payload) => ipcRenderer.invoke('db:benchmarks:add', payload),
  updateBenchmark: (payload) => ipcRenderer.invoke('db:benchmarks:update', payload),
  deleteBenchmark: (payload) => ipcRenderer.invoke('db:benchmarks:delete', payload),
  tasks: {
    get: (payload) => ipcRenderer.invoke('db:tasks:get', payload),
    add: (payload) => ipcRenderer.invoke('db:tasks:add', payload),
    update: (payload) => ipcRenderer.invoke('db:tasks:update', payload),
    delete: (payload) => ipcRenderer.invoke('db:tasks:delete', payload),
    reorder: (payload) => ipcRenderer.invoke('db:tasks:reorder', payload),
  },
  getResults: () => ipcRenderer.invoke('db:results:get'),
  addResult: (payload) => ipcRenderer.invoke('db:results:add', payload),
  deleteResult: (payload) => ipcRenderer.invoke('db:results:delete', payload),
  clearResults: () => ipcRenderer.invoke('db:results:clear'),
  rebuildResultArtifacts: () => ipcRenderer.invoke('db:results:rebuild-artifacts'),
  getRuns: () => ipcRenderer.invoke('db:runs:get'),
  addRun: (payload) => ipcRenderer.invoke('db:runs:add', payload),
  updateRun: (payload) => ipcRenderer.invoke('db:runs:update', payload),
  runSession: {
    create: (payload) => ipcRenderer.invoke('run-session:create', payload),
    getActive: () => ipcRenderer.invoke('run-session:get-active'),
    update: (payload) => ipcRenderer.invoke('run-session:update', payload),
    finish: (payload) => ipcRenderer.invoke('run-session:finish', payload),
    cancel: (payload) => ipcRenderer.invoke('run-session:cancel', payload),
  },
  exportAll: () => ipcRenderer.invoke('db:export-all'),
  clearAllData: () => ipcRenderer.invoke('db:clear-all'),
  importAll: (payload) => ipcRenderer.invoke('db:import-all', payload),
  testConnection: (payload) => ipcRenderer.invoke('model:test-connection', payload),
  scanModels: (payload) => ipcRenderer.invoke('models:scan', payload),
  sendPrompt: (payload) => ipcRenderer.invoke('model:send-prompt', payload),
  runBenchmark: (payload) => ipcRenderer.invoke('benchmark:run', payload),
  runBenchmarkStreaming: (payload) => ipcRenderer.invoke('benchmark:run-streaming', payload),
  abortBenchmark: () => ipcRenderer.invoke('benchmark:abort'),
  submitManualResult: (payload) => ipcRenderer.invoke('benchmark:submit-manual', payload),
  submitManualStreaming: (payload) => ipcRenderer.invoke('benchmark:submit-manual-streaming', payload),
  submitManualBatch: (payload) => ipcRenderer.invoke('benchmark:submit-manual-batch', payload),
  onStreamEvent: (callback) => {
    ipcRenderer.on('task:chunk', (_, data) => callback('task:chunk', data))
    ipcRenderer.on('task:thinking-chunk', (_, data) => callback('task:thinking-chunk', data))
    ipcRenderer.on('task:done', (_, data) => callback('task:done', data))
    ipcRenderer.on('task:error', (_, data) => callback('task:error', data))
    ipcRenderer.on('task:retry', (_, data) => callback('task:retry', data))
    ipcRenderer.on('task:tool-call', (_, data) => callback('task:tool-call', data))
    ipcRenderer.on('task:needs-maze-verify', (_, data) => callback('task:needs-maze-verify', data))
    ipcRenderer.on('benchmark:done', (_, data) => callback('benchmark:done', data))
    ipcRenderer.on('benchmark:aborted', (_, data) => callback('benchmark:aborted', data))
  },
  onAborted: (callback) => ipcRenderer.on('benchmark:aborted', callback),
  removeStreamListeners: () => {
    ipcRenderer.removeAllListeners('task:chunk')
    ipcRenderer.removeAllListeners('task:thinking-chunk')
    ipcRenderer.removeAllListeners('task:done')
    ipcRenderer.removeAllListeners('task:error')
    ipcRenderer.removeAllListeners('task:retry')
    ipcRenderer.removeAllListeners('task:tool-call')
    ipcRenderer.removeAllListeners('task:needs-maze-verify')
    ipcRenderer.removeAllListeners('benchmark:done')
    ipcRenderer.removeAllListeners('benchmark:aborted')
  },
  savePreference: (key, value) => ipcRenderer.invoke('db:preference:set', key, value),
  getPreference: (key) => ipcRenderer.invoke('db:preference:get', key),
})
