const crypto = require('crypto')

const DEFAULT_BEACON_PATHS = ['benchforge.beacon', '.benchforge/benchforge.beacon', '.benchforge/beacon.json']
const DEFAULT_MANIFEST_PATHS = ['benchforge.json', '.benchforge/benchforge.json']
const DEFAULT_TOPIC = 'benchforge-pack'
const MAX_TEXT_BYTES = 10 * 1024 * 1024
const CACHE_TTL_MS = 15 * 60 * 1000
const memoryCache = new Map()

function getCached(key, forceRefresh = false) {
  if (forceRefresh) return null
  const cached = memoryCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.savedAt > CACHE_TTL_MS) {
    memoryCache.delete(key)
    return null
  }
  return cached.value
}

function setCached(key, value) {
  memoryCache.set(key, { savedAt: Date.now(), value })
  return value
}

function getAuthHeaders(options = {}) {
  const token = String(options.token || options.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  return token ? { authorization: `Bearer ${token}` } : {}
}

function normalizePath(value) {
  return String(value || '').replace(/^\/+/, '').replace(/\\/g, '/')
}

function isSafeGithubPath(value) {
  const path = normalizePath(value)
  if (!path || path.includes('..')) return false
  return /^[\w./@+\- ]+$/.test(path)
}

function parseGithubUrl(input) {
  const value = String(input || '').trim()
  if (!value) throw new Error('Podaj URL repozytorium GitHub albo raw URL.')

  const normalized = value.startsWith('http') ? value : `https://github.com/${value.replace(/^\/+/, '')}`
  const url = new URL(normalized)

  if (url.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...pathParts] = url.pathname.split('/').filter(Boolean)
    if (!owner || !repo || !ref) throw new Error('Niepoprawny raw.githubusercontent.com URL.')
    return { owner, repo, ref, path: pathParts.join('/'), raw: true, repoUrl: `https://github.com/${owner}/${repo}` }
  }

  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') throw new Error('Radar obsługuje na razie tylko github.com.')
  const [owner, repoWithGit, mode, ref, ...pathParts] = url.pathname.split('/').filter(Boolean)
  const repo = repoWithGit?.replace(/\.git$/i, '')
  if (!owner || !repo) throw new Error('Niepoprawny URL repozytorium GitHub.')

  if (mode === 'blob' || mode === 'tree') {
    return { owner, repo, ref: ref || null, path: pathParts.join('/'), raw: mode === 'blob', repoUrl: `https://github.com/${owner}/${repo}` }
  }

  return { owner, repo, ref: null, path: '', raw: false, repoUrl: `https://github.com/${owner}/${repo}` }
}

async function fetchText(url, timeoutMs = 12000, maxBytes = MAX_TEXT_BYTES, options = {}) {
  const cacheKey = `text:${url}`
  const cached = getCached(cacheKey, options.forceRefresh)
  if (cached !== null) return cached
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'BenchForge-Radar', accept: 'application/vnd.github+json, application/json, text/plain, */*', ...getAuthHeaders(options) }, signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const length = Number(response.headers.get('content-length') || 0)
    if (length && length > maxBytes) throw new Error(`Plik za duży (${length} B). Limit: ${maxBytes} B.`)
    const text = await response.text()
    if (text.length > maxBytes) throw new Error(`Plik za duży (${text.length} znaków). Limit: ${maxBytes} znaków.`)
    return setCached(cacheKey, text)
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchJson(url, timeoutMs = 12000, options = {}) {
  const text = await fetchText(url, timeoutMs, MAX_TEXT_BYTES, options)
  return JSON.parse(text)
}

async function getRepoMeta(owner, repo, options = {}) {
  return fetchJson(`https://api.github.com/repos/${owner}/${repo}`, 12000, options)
}

function rawUrl(owner, repo, ref, filePath) {
  if (!isSafeGithubPath(filePath)) throw new Error(`Niebezpieczna ścieżka w manifeście: ${filePath}`)
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref).replace(/%2F/g, '/')}/${normalizePath(filePath).split('/').map(encodeURIComponent).join('/')}`
}

async function tryFetchRaw(owner, repo, ref, filePath, options = {}) {
  try {
    return await fetchText(rawUrl(owner, repo, ref, filePath), 12000, MAX_TEXT_BYTES, options)
  } catch {
    return null
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex')
}

function normalizeSha256(value) {
  return String(value || '').trim().toLowerCase().replace(/^sha256[:=-]/, '')
}

function verifyChecksum(text, expected, label) {
  const normalized = normalizeSha256(expected)
  if (!normalized) return null
  const actual = sha256(text)
  if (actual !== normalized) throw new Error(`Checksum mismatch for ${label}. Expected ${normalized}, got ${actual}.`)
  return actual
}

function parseMaybeJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Niepoprawny JSON w ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseBeacon(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return { type: 'benchforge-beacon', manifest: 'benchforge.json' }
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? parsed : { type: 'benchforge-beacon', manifest: 'benchforge.json' }
  } catch {
    const manifestLine = trimmed.split(/\r?\n/g).map((line) => line.trim()).find((line) => line && !line.startsWith('#'))
    return { type: 'benchforge-beacon', manifest: manifestLine || 'benchforge.json' }
  }
}

function normalizeBenchmarkPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.benchmarks)) return payload.benchmarks
    if (payload.name || payload.prompt_template || payload.tasks) return [payload]
  }
  return []
}

function validateScoreType(value) {
  return value === undefined || value === null || value === '' || value === 'numeric' || value === 'boolean'
}

function validateOutputType(value) {
  return value === undefined || value === null || value === '' || ['text', 'markdown', 'html', 'svg', 'maze'].includes(String(value))
}

function validatePack(manifest, benchmarks) {
  const errors = []
  const warnings = []

  if (manifest.type && manifest.type !== 'benchforge-pack') warnings.push(`Manifest type is '${manifest.type}', expected 'benchforge-pack'.`)
  if (!manifest.name && !manifest.title) warnings.push('Manifest should include name/title.')
  if (!manifest.version) warnings.push('Manifest should include version for update checks.')
  if (!Array.isArray(benchmarks) || benchmarks.length === 0) errors.push('Manifest must resolve to at least one benchmark.')

  benchmarks.forEach((benchmark, index) => {
    const label = `benchmark[${index}]`
    if (!benchmark || typeof benchmark !== 'object') {
      errors.push(`${label} is not an object.`)
      return
    }
    if (!String(benchmark.name || '').trim()) errors.push(`${label}.name is required.`)
    if (!validateScoreType(benchmark.score_type)) errors.push(`${label}.score_type must be numeric or boolean.`)
    if (!validateOutputType(benchmark.output_type)) errors.push(`${label}.output_type is invalid.`)

    const tasks = Array.isArray(benchmark.tasks) ? benchmark.tasks : []
    const hasPrompt = Boolean(String(benchmark.prompt_template || '').trim())
    if (!hasPrompt && tasks.length === 0) errors.push(`${label} must include prompt_template or non-empty tasks.`)
    if (!benchmark.category) warnings.push(`${label}.category is missing; BenchForge will default it during import.`)

    tasks.forEach((task, taskIndex) => {
      const taskLabel = `${label}.tasks[${taskIndex}]`
      if (!task || typeof task !== 'object') {
        errors.push(`${taskLabel} is not an object.`)
        return
      }
      if (!String(task.name || '').trim()) warnings.push(`${taskLabel}.name is missing; BenchForge will generate a name during import.`)
      if (!String(task.prompt_template || task.promptTemplate || '').trim()) errors.push(`${taskLabel}.prompt_template is required.`)
      if (!validateScoreType(task.score_type)) errors.push(`${taskLabel}.score_type must be numeric or boolean.`)
      if (!validateOutputType(task.output_type)) errors.push(`${taskLabel}.output_type is invalid.`)
    })
  })

  return { ok: errors.length === 0, errors, warnings }
}

async function loadBenchmarkEntry(entry, context) {
  if (typeof entry === 'string') {
    const text = await fetchText(resolveManifestUrl(entry, context), 12000, MAX_TEXT_BYTES, context)
    verifyChecksum(text, context.checksums?.[normalizePath(entry)] || context.checksums?.[entry], entry)
    return normalizeBenchmarkPayload(parseMaybeJson(text, entry))
  }

  if (!entry || typeof entry !== 'object') return []
  if (entry.benchmark && typeof entry.benchmark === 'object') return [entry.benchmark]
  if (Array.isArray(entry.benchmarks) && !entry.path && !entry.source && !entry.url) return entry.benchmarks

  const filePath = entry.path || entry.source || entry.file || entry.url
  if (typeof filePath === 'string' && filePath.trim()) {
    const text = await fetchText(resolveManifestUrl(filePath, context), 12000, MAX_TEXT_BYTES, context)
    verifyChecksum(text, entry.sha256 || entry.checksum || context.checksums?.[normalizePath(filePath)] || context.checksums?.[filePath], filePath)
    return normalizeBenchmarkPayload(parseMaybeJson(text, filePath))
  }

  if (entry.name || entry.prompt_template || entry.tasks) return [entry]
  return []
}

function resolveManifestUrl(filePath, context) {
  const value = String(filePath || '').trim()
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value)
    if (url.hostname !== 'raw.githubusercontent.com' && url.hostname !== 'github.com' && url.hostname !== 'www.github.com') throw new Error('Manifest może pobierać benchmarki tylko z GitHuba/Raw GitHub.')
    if (url.hostname === 'raw.githubusercontent.com') return value
    const parsed = parseGithubUrl(value)
    if (!parsed.raw || !parsed.ref || !parsed.path) throw new Error(`Link GitHub musi wskazywać plik: ${value}`)
    return rawUrl(parsed.owner, parsed.repo, parsed.ref, parsed.path)
  }

  if (!isSafeGithubPath(value)) throw new Error(`Niebezpieczna ścieżka w manifeście: ${value}`)
  const baseDir = context.manifestPath.includes('/') ? context.manifestPath.split('/').slice(0, -1).join('/') : ''
  const relative = normalizePath(baseDir ? `${baseDir}/${value}` : value)
  return rawUrl(context.owner, context.repo, context.ref, relative)
}

async function buildPackFromManifest({ manifest, manifestPath, owner, repo, ref, repoUrl, beaconPath = null, token = null, forceRefresh = false }) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Manifest musi być obiektem JSON.')
  const manifestObject = Array.isArray(manifest) ? { benchmarks: manifest } : manifest
  const context = { owner, repo, ref, manifestPath, token, forceRefresh, checksums: manifestObject.checksums && typeof manifestObject.checksums === 'object' ? manifestObject.checksums : {} }
  const benchmarkEntries = Array.isArray(manifestObject.benchmarks) ? manifestObject.benchmarks : []
  const benchmarks = []
  for (const entry of benchmarkEntries) benchmarks.push(...await loadBenchmarkEntry(entry, context))

  if (benchmarks.length === 0 && (manifestObject.name || manifestObject.prompt_template || manifestObject.tasks)) benchmarks.push(...normalizeBenchmarkPayload(manifestObject))
  if (benchmarks.length === 0) throw new Error('Manifest nie zawiera żadnych benchmarków do importu.')

  const taskCount = benchmarks.reduce((sum, benchmark) => sum + (Array.isArray(benchmark?.tasks) ? benchmark.tasks.length : 1), 0)
  const validation = validatePack(manifestObject, benchmarks)
  return {
    ok: true,
    id: `${owner}/${repo}#${ref}:${manifestPath}`,
    owner,
    repo,
    ref,
    name: String(manifestObject.name || manifestObject.title || `${owner}/${repo}`),
    description: String(manifestObject.description || `BenchForge beacon from ${owner}/${repo}`),
    version: manifestObject.version ? String(manifestObject.version) : null,
    author: manifestObject.author ? String(manifestObject.author) : null,
    license: manifestObject.license ? String(manifestObject.license) : null,
    source: `${owner}/${repo}`,
    repoUrl,
    homepage: manifestObject.homepage ? String(manifestObject.homepage) : repoUrl,
    manifestPath,
    beaconPath,
    benchmarks,
    benchmarkCount: benchmarks.length,
    taskCount,
    validation,
    cachedAt: new Date().toISOString(),
  }
}

async function scanBenchmarkBeacon(payload = {}) {
  const options = { token: payload.token || payload.githubToken || null, forceRefresh: Boolean(payload.forceRefresh) }
  const parsed = parseGithubUrl(payload.url || payload.repo || payload.repository)
  const repoMeta = parsed.ref ? null : await getRepoMeta(parsed.owner, parsed.repo, options)
  const ref = parsed.ref || repoMeta?.default_branch || 'main'
  const repoUrl = parsed.repoUrl

  if (parsed.raw && parsed.path) {
    const text = await fetchText(rawUrl(parsed.owner, parsed.repo, ref, parsed.path), 12000, MAX_TEXT_BYTES, options)
    const manifest = parseMaybeJson(text, parsed.path)
    return buildPackFromManifest({ manifest, manifestPath: parsed.path, owner: parsed.owner, repo: parsed.repo, ref, repoUrl, beaconPath: null, ...options })
  }

  const candidatePaths = parsed.path ? [normalizePath(parsed.path)] : DEFAULT_BEACON_PATHS
  let beacon = null
  let beaconPath = null
  for (const candidate of candidatePaths) {
    const text = await tryFetchRaw(parsed.owner, parsed.repo, ref, candidate, options)
    if (text === null) continue
    beacon = parseBeacon(text)
    beaconPath = candidate
    break
  }

  const manifestCandidates = []
  if (beacon?.manifest) manifestCandidates.push(normalizePath(String(beacon.manifest)))
  manifestCandidates.push(...DEFAULT_MANIFEST_PATHS)

  for (const manifestPath of Array.from(new Set(manifestCandidates))) {
    const text = await tryFetchRaw(parsed.owner, parsed.repo, ref, manifestPath, options)
    if (text === null) continue
    const manifest = parseMaybeJson(text, manifestPath)
    return buildPackFromManifest({ manifest, manifestPath, owner: parsed.owner, repo: parsed.repo, ref, repoUrl, beaconPath, ...options })
  }

  throw new Error(`Nie znaleziono benchforge.beacon ani benchforge.json w ${parsed.owner}/${parsed.repo}.`)
}

async function discoverBenchmarkBeacons(payload = {}) {
  const options = { token: payload.token || payload.githubToken || null, forceRefresh: Boolean(payload.forceRefresh) }
  const topic = String(payload.topic || DEFAULT_TOPIC).trim().replace(/^topic:/i, '') || DEFAULT_TOPIC
  const limit = Math.max(1, Math.min(30, Number(payload.limit || 12)))
  const search = await fetchJson(`https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}&sort=updated&order=desc&per_page=${limit}`, 12000, options)
  const repos = Array.isArray(search.items) ? search.items.slice(0, limit) : []
  const packs = []
  const errors = []

  for (const repo of repos) {
    const fullName = repo?.full_name
    if (!fullName) continue
    try {
      packs.push(await scanBenchmarkBeacon({ url: `https://github.com/${fullName}`, ...options }))
    } catch (error) {
      errors.push({ repo: fullName, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { ok: true, topic, total: Number(search.total_count || packs.length), packs, errors }
}

module.exports = { scanBenchmarkBeacon, discoverBenchmarkBeacons }
