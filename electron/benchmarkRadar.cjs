const DEFAULT_BEACON_PATHS = ['benchforge.beacon', '.benchforge/benchforge.beacon', '.benchforge/beacon.json']
const DEFAULT_MANIFEST_PATHS = ['benchforge.json', '.benchforge/benchforge.json']
const DEFAULT_TOPIC = 'benchforge-pack'
const MAX_TEXT_BYTES = 10 * 1024 * 1024

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

async function fetchText(url, timeoutMs = 12000, maxBytes = MAX_TEXT_BYTES) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'BenchForge-Radar', accept: 'application/vnd.github+json, application/json, text/plain, */*' }, signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const length = Number(response.headers.get('content-length') || 0)
    if (length && length > maxBytes) throw new Error(`Plik za duży (${length} B). Limit: ${maxBytes} B.`)
    const text = await response.text()
    if (text.length > maxBytes) throw new Error(`Plik za duży (${text.length} znaków). Limit: ${maxBytes} znaków.`)
    return text
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchJson(url, timeoutMs = 12000) {
  const text = await fetchText(url, timeoutMs)
  return JSON.parse(text)
}

async function getRepoMeta(owner, repo) {
  return fetchJson(`https://api.github.com/repos/${owner}/${repo}`)
}

function rawUrl(owner, repo, ref, filePath) {
  if (!isSafeGithubPath(filePath)) throw new Error(`Niebezpieczna ścieżka w manifeście: ${filePath}`)
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref).replace(/%2F/g, '/')}/${normalizePath(filePath).split('/').map(encodeURIComponent).join('/')}`
}

async function tryFetchRaw(owner, repo, ref, filePath) {
  try {
    return await fetchText(rawUrl(owner, repo, ref, filePath))
  } catch {
    return null
  }
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

async function loadBenchmarkEntry(entry, context) {
  if (typeof entry === 'string') {
    const text = await fetchText(resolveManifestUrl(entry, context))
    return normalizeBenchmarkPayload(parseMaybeJson(text, entry))
  }

  if (!entry || typeof entry !== 'object') return []
  if (entry.benchmark && typeof entry.benchmark === 'object') return [entry.benchmark]
  if (Array.isArray(entry.benchmarks) && !entry.path && !entry.source && !entry.url) return entry.benchmarks

  const filePath = entry.path || entry.source || entry.file || entry.url
  if (typeof filePath === 'string' && filePath.trim()) {
    const text = await fetchText(resolveManifestUrl(filePath, context))
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

async function buildPackFromManifest({ manifest, manifestPath, owner, repo, ref, repoUrl, beaconPath = null }) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Manifest musi być obiektem JSON.')
  const manifestObject = Array.isArray(manifest) ? { benchmarks: manifest } : manifest
  const context = { owner, repo, ref, manifestPath }
  const benchmarkEntries = Array.isArray(manifestObject.benchmarks) ? manifestObject.benchmarks : []
  const benchmarks = []
  for (const entry of benchmarkEntries) benchmarks.push(...await loadBenchmarkEntry(entry, context))

  if (benchmarks.length === 0 && (manifestObject.name || manifestObject.prompt_template || manifestObject.tasks)) benchmarks.push(...normalizeBenchmarkPayload(manifestObject))
  if (benchmarks.length === 0) throw new Error('Manifest nie zawiera żadnych benchmarków do importu.')

  const taskCount = benchmarks.reduce((sum, benchmark) => sum + (Array.isArray(benchmark?.tasks) ? benchmark.tasks.length : 1), 0)
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
  }
}

async function scanBenchmarkBeacon(payload = {}) {
  const parsed = parseGithubUrl(payload.url || payload.repo || payload.repository)
  const repoMeta = parsed.ref ? null : await getRepoMeta(parsed.owner, parsed.repo)
  const ref = parsed.ref || repoMeta?.default_branch || 'main'
  const repoUrl = parsed.repoUrl

  if (parsed.raw && parsed.path) {
    const text = await fetchText(rawUrl(parsed.owner, parsed.repo, ref, parsed.path))
    const manifest = parseMaybeJson(text, parsed.path)
    return buildPackFromManifest({ manifest, manifestPath: parsed.path, owner: parsed.owner, repo: parsed.repo, ref, repoUrl, beaconPath: null })
  }

  const candidatePaths = parsed.path ? [normalizePath(parsed.path)] : DEFAULT_BEACON_PATHS
  let beacon = null
  let beaconPath = null
  for (const candidate of candidatePaths) {
    const text = await tryFetchRaw(parsed.owner, parsed.repo, ref, candidate)
    if (text === null) continue
    beacon = parseBeacon(text)
    beaconPath = candidate
    break
  }

  const manifestCandidates = []
  if (beacon?.manifest) manifestCandidates.push(normalizePath(String(beacon.manifest)))
  manifestCandidates.push(...DEFAULT_MANIFEST_PATHS)

  for (const manifestPath of Array.from(new Set(manifestCandidates))) {
    const text = await tryFetchRaw(parsed.owner, parsed.repo, ref, manifestPath)
    if (text === null) continue
    const manifest = parseMaybeJson(text, manifestPath)
    return buildPackFromManifest({ manifest, manifestPath, owner: parsed.owner, repo: parsed.repo, ref, repoUrl, beaconPath })
  }

  throw new Error(`Nie znaleziono benchforge.beacon ani benchforge.json w ${parsed.owner}/${parsed.repo}.`)
}

async function discoverBenchmarkBeacons(payload = {}) {
  const topic = String(payload.topic || DEFAULT_TOPIC).trim().replace(/^topic:/i, '') || DEFAULT_TOPIC
  const limit = Math.max(1, Math.min(30, Number(payload.limit || 12)))
  const search = await fetchJson(`https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}&sort=updated&order=desc&per_page=${limit}`)
  const repos = Array.isArray(search.items) ? search.items.slice(0, limit) : []
  const packs = []
  const errors = []

  for (const repo of repos) {
    const fullName = repo?.full_name
    if (!fullName) continue
    try {
      packs.push(await scanBenchmarkBeacon({ url: `https://github.com/${fullName}` }))
    } catch (error) {
      errors.push({ repo: fullName, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { ok: true, topic, total: Number(search.total_count || packs.length), packs, errors }
}

module.exports = { scanBenchmarkBeacon, discoverBenchmarkBeacons }
