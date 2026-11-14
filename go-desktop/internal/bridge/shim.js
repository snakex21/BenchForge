// BenchForge WebView2 bridge: replaces electron/preload.cjs.
// Exposes the exact window.benchforge / window.db API the React UI already
// uses, backed by one Go binding (__bf_invoke) and an event channel
// (__bfEmit). Injected by webview.Init() before any page script runs.
(function () {
  'use strict'
  var ORIGIN = __BF_ORIGIN__
  var TOKEN = __BF_TOKEN__
  var STORAGE = __BF_STORAGE__

  // Never run the bridge (or keep the page) outside our own origin: the
  // window must not show remote content.
  if (window.location.origin !== ORIGIN) {
    if (/^https?:$/.test(window.location.protocol)) {
      try { window.stop() } catch (e) {}
      try { document.open(); document.write('Blocked: BenchForge does not display remote content.'); document.close() } catch (e) {}
    }
    return
  }
  if (window.top !== window) return
  if (typeof window.__bf_invoke !== 'function') {
    console.error('[benchforge] Go binding missing')
  }

  var seq = 0
  var pending = Object.create(null)

  function call(channel) {
    var args = Array.prototype.slice.call(arguments, 1)
    return new Promise(function (resolve, reject) {
      var id = ++seq
      pending[id] = { resolve: resolve, reject: reject }
      var json
      try {
        json = JSON.stringify(args, function (_k, v) { return v === undefined ? null : v })
      } catch (err) {
        delete pending[id]
        reject(err)
        return
      }
      try {
        window.__bf_invoke(TOKEN, id, channel, json)
      } catch (err) {
        delete pending[id]
        reject(err)
      }
    })
  }

  Object.defineProperty(window, '__bfSettle', {
    value: function (id, ok, payload) {
      var p = pending[id]
      if (!p) return
      delete pending[id]
      if (ok) p.resolve(payload)
      else p.reject(new Error(typeof payload === 'string' ? payload : 'Unknown error'))
    },
    writable: false, configurable: false, enumerable: false,
  })

  var STREAM_EVENTS = ['task:chunk', 'task:thinking-chunk', 'task:done', 'task:error', 'task:retry', 'task:tool-call', 'task:needs-maze-verify', 'benchmark:done', 'benchmark:aborted']
  var listeners = Object.create(null)
  function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn) }
  function off(name) { delete listeners[name] }

  Object.defineProperty(window, '__bfEmit', {
    value: function (name, data) {
      var list = listeners[name]
      if (!list) return
      list.slice().forEach(function (fn) {
        try { fn(name, data) } catch (err) { console.error('[benchforge] listener failed', err) }
      })
    },
    writable: false, configurable: false, enumerable: false,
  })

  var benchforge = {
    getMeta: function () { return call('app:get-meta') },
    getDataPath: function () { return call('app:get-data-path') },
    openDataPath: function () { return call('app:open-data-path') },
    openExternal: function (url) { return call('app:open-external', url) },
    checkForUpdates: function (payload) { return call('updates:check', payload) },
    downloadUpdate: function (payload) { return call('updates:download', payload) },
    applyPortableUpdate: function (payload) { return call('updates:apply-portable', payload) },
    getPricingStatus: function () { return call('pricing:status') },
    refreshOpenRouterPricing: function () { return call('pricing:refresh-openrouter') },
    saveJsonFile: function (payload) { return call('files:save-json', payload) },
    saveTextFile: function (payload) { return call('files:save-text', payload) },
    openJsonFile: function () { return call('files:open-json') },
    openPath: function (relativePath) { return call('files:open-path', relativePath) },
    exportArtifactZip: function (payload) { return call('files:export-artifact-zip', payload) },
    listBenchmarkPacks: function () { return call('benchmark-library:list') },
    downloadBenchmarkPack: function (payload) { return call('benchmark-library:download', payload) },
    scanBenchmarkBeacon: function (payload) { return call('benchmark-radar:scan', payload) },
    discoverBenchmarkBeacons: function (payload) { return call('benchmark-radar:discover', payload) },
    listTools: function () { return call('tools:list') },
    runTool: function (payload) { return call('tools:run', payload) },
    checkEnvironment: function () { return call('env:check') },
    healthCheck: function () { return call('health:check') },
    getMcpServers: function () { return call('mcp:servers:get') },
    saveMcpServers: function (servers) { return call('mcp:servers:save', { servers: servers }) },
    listMcpTools: function () { return call('mcp:tools:list') },
    callMcpTool: function (payload) { return call('mcp:tool:call', payload) },
    judgeEvaluate: function (payload) { return call('judge:evaluate', payload) },
  }

  var db = {
    getModels: function () { return call('db:models:get') },
    addModel: function (payload) { return call('db:models:add', payload) },
    updateModel: function (payload) { return call('db:models:update', payload) },
    deleteModel: function (payload) { return call('db:models:delete', payload) },
    getDiscoveredModels: function (payload) { return call('db:discovered-models:get', payload) },
    providerConfigs: {
      getAll: function () { return call('db:provider-configs:get-all') },
      get: function (provider) { return call('db:provider-configs:get', provider) },
      save: function (provider, data) { return call('db:provider-configs:save', { provider: provider, data: data }) },
      delete: function (provider) { return call('db:provider-configs:delete', provider) },
    },
    getBenchmarks: function () { return call('db:benchmarks:get') },
    addBenchmark: function (payload) { return call('db:benchmarks:add', payload) },
    updateBenchmark: function (payload) { return call('db:benchmarks:update', payload) },
    deleteBenchmark: function (payload) { return call('db:benchmarks:delete', payload) },
    tasks: {
      get: function (payload) { return call('db:tasks:get', payload) },
      add: function (payload) { return call('db:tasks:add', payload) },
      update: function (payload) { return call('db:tasks:update', payload) },
      delete: function (payload) { return call('db:tasks:delete', payload) },
      reorder: function (payload) { return call('db:tasks:reorder', payload) },
    },
    getResults: function () { return call('db:results:get') },
    addResult: function (payload) { return call('db:results:add', payload) },
    deleteResult: function (payload) { return call('db:results:delete', payload) },
    clearResults: function () { return call('db:results:clear') },
    rebuildResultArtifacts: function () { return call('db:results:rebuild-artifacts') },
    getRuns: function () { return call('db:runs:get') },
    addRun: function (payload) { return call('db:runs:add', payload) },
    updateRun: function (payload) { return call('db:runs:update', payload) },
    runSession: {
      create: function (payload) { return call('run-session:create', payload) },
      getActive: function () { return call('run-session:get-active') },
      update: function (payload) { return call('run-session:update', payload) },
      finish: function (payload) { return call('run-session:finish', payload) },
      cancel: function (payload) { return call('run-session:cancel', payload) },
    },
    exportAll: function () { return call('db:export-all') },
    clearAllData: function () { return call('db:clear-all') },
    importAll: function (payload) { return call('db:import-all', payload) },
    testConnection: function (payload) { return call('model:test-connection', payload) },
    scanModels: function (payload) { return call('models:scan', payload) },
    sendPrompt: function (payload) { return call('model:send-prompt', payload) },
    runBenchmark: function (payload) { return call('benchmark:run', payload) },
    runBenchmarkStreaming: function (payload) { return call('benchmark:run-streaming', payload) },
    abortBenchmark: function () { return call('benchmark:abort') },
    submitManualResult: function (payload) { return call('benchmark:submit-manual', payload) },
    submitManualStreaming: function (payload) { return call('benchmark:submit-manual-streaming', payload) },
    submitManualBatch: function (payload) { return call('benchmark:submit-manual-batch', payload) },
    onStreamEvent: function (callback) {
      STREAM_EVENTS.forEach(function (name) { on(name, function (n, data) { callback(n, data) }) })
    },
    onAborted: function (callback) { on('benchmark:aborted', function () { callback() }) },
    removeStreamListeners: function () { STREAM_EVENTS.forEach(off) },
    savePreference: function (key, value) { return call('db:preference:set', key, value) },
    getPreference: function (key) { return call('db:preference:get', key) },
  }

  function freeze(o) {
    Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === 'object') freeze(o[k]) })
    return Object.freeze(o)
  }
  Object.defineProperty(window, 'benchforge', { value: freeze(benchforge), writable: false, configurable: false })
  Object.defineProperty(window, 'db', { value: freeze(db), writable: false, configurable: false })

  // ---- localStorage persistence across launches (the port, and therefore
  // the origin, can change). Values are mirrored to Go and restored here
  // before the UI reads them.
  try {
    var ls = window.localStorage
    Object.keys(STORAGE || {}).forEach(function (k) {
      if (ls.getItem(k) === null) ls.setItem(k, STORAGE[k])
    })
    var proto = Object.getPrototypeOf(ls)
    var setItem = proto.setItem, removeItem = proto.removeItem, clear = proto.clear
    var timer = null
    function sync() {
      if (timer) return
      timer = setTimeout(function () {
        timer = null
        var snap = {}
        for (var i = 0; i < ls.length; i++) { var key = ls.key(i); snap[key] = ls.getItem(key) }
        call('internal:storage-sync', snap).catch(function () {})
      }, 250)
    }
    proto.setItem = function () { var r = setItem.apply(this, arguments); if (this === ls) sync(); return r }
    proto.removeItem = function () { var r = removeItem.apply(this, arguments); if (this === ls) sync(); return r }
    proto.clear = function () { var r = clear.apply(this, arguments); if (this === ls) sync(); return r }
  } catch (e) {}

  // ---- No navigation away from the app, no popups: external links open in
  // the default browser (HTTPS only, enforced again in Go).
  function external(url) {
    try {
      var u = new URL(url, window.location.href)
      if (u.origin === ORIGIN) return false
      call('app:open-external', u.href).catch(function () {})
      return true
    } catch (e) { return true }
  }
  document.addEventListener('click', function (ev) {
    var el = ev.target
    while (el && el.nodeName !== 'A') el = el.parentNode
    if (!el || !el.getAttribute) return
    var href = el.getAttribute('href')
    if (!href || href.charAt(0) === '#') return
    if (/^(blob:|data:)/i.test(href) && el.hasAttribute('download')) return
    var u
    try { u = new URL(href, window.location.href) } catch (e) { ev.preventDefault(); return }
    if (u.origin !== ORIGIN || el.target === '_blank') {
      ev.preventDefault()
      if (u.origin !== ORIGIN) external(u.href)
    }
  }, true)
  window.open = function (url) { if (url) external(String(url)); return null }
})()
