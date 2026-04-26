const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/')
}

function getUserDataPath() {
  return app.getPath('userData')
}

function getArtifactsRoot() {
  return path.join(getUserDataPath(), 'artifacts')
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, String(content ?? ''), 'utf-8')
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2))
}

function responseExtension(outputType) {
  switch (outputType) {
    case 'html': return 'html'
    case 'svg': return 'svg'
    case 'markdown': return 'md'
    case 'maze': return 'json'
    default: return 'txt'
  }
}

function previewText(value, limit = 600) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function sanitizeModel(model) {
  if (!model) return null
  const { api_key: _apiKey, ...safeModel } = model
  return safeModel
}

function resultArtifactRelativePath(result) {
  const sessionPart = result.run_session_id ? `session-${result.run_session_id}` : 'legacy'
  const benchmarkPart = `benchmark-${result.benchmark_id}`
  const resultPart = result.task_id ? `result-${result.id}-task-${result.task_id}` : `result-${result.id}-aggregate`
  return toPosix(path.join('artifacts', 'runs', sessionPart, benchmarkPart, resultPart))
}

function resolveArtifactPath(relativePath) {
  if (!relativePath) return null
  const userData = path.resolve(getUserDataPath())
  const absolute = path.resolve(userData, relativePath)
  const relative = path.relative(userData, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}

function removeArtifact(relativePath) {
  const absolute = resolveArtifactPath(relativePath)
  if (!absolute || !fs.existsSync(absolute)) return
  fs.rmSync(absolute, { recursive: true, force: true })
}

function clearArtifacts() {
  const root = getArtifactsRoot()
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
}

function writeResultArtifacts({ result, model, benchmark, task }) {
  const relativePath = result.artifact_path || resultArtifactRelativePath(result)
  const absolutePath = resolveArtifactPath(relativePath)
  if (!absolutePath) throw new Error('Invalid artifact path')
  ensureDir(absolutePath)

  const outputType = task?.output_type || benchmark?.output_type || 'text'
  const ext = responseExtension(outputType)
  const prompt = task?.prompt_template || benchmark?.prompt_template || ''
  const response = result.notes || ''
  const thinking = result.thinking_notes || ''

  writeText(path.join(absolutePath, 'prompt.md'), prompt)
  writeText(path.join(absolutePath, `response.${ext}`), response)
  if (thinking.trim()) writeText(path.join(absolutePath, 'thinking.md'), thinking)

  writeJson(path.join(absolutePath, 'result.json'), {
    id: result.id,
    model_id: result.model_id,
    benchmark_id: result.benchmark_id,
    task_id: result.task_id ?? null,
    run_session_id: result.run_session_id ?? null,
    score: result.score,
    attempt_number: result.attempt_number,
    tokens_used: result.tokens_used,
    duration_ms: result.duration_ms,
    run_at: result.run_at,
    output_type: outputType,
    response_file: `response.${ext}`,
    has_thinking: Boolean(thinking.trim()),
    response_preview: previewText(response),
  })

  writeJson(path.join(absolutePath, 'model.snapshot.json'), sanitizeModel(model))
  writeJson(path.join(absolutePath, 'benchmark.snapshot.json'), benchmark || null)
  if (task) writeJson(path.join(absolutePath, 'task.snapshot.json'), task)

  return relativePath
}

function collectFiles(root, current = root, out = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) collectFiles(root, absolute, out)
    else out.push({ absolute, relative: toPosix(path.relative(root, absolute)) })
  }
  return out
}

function zipDirectory(relativePath, outputPath) {
  const root = resolveArtifactPath(relativePath)
  if (!root || !fs.existsSync(root)) throw new Error('Artifact path does not exist')
  const files = collectFiles(root)
  const chunks = []
  const central = []
  let offset = 0
  const now = dosDateTime()

  for (const file of files) {
    const data = fs.readFileSync(file.absolute)
    const name = Buffer.from(file.relative, 'utf-8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, data)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(now.time, 12)
    header.writeUInt16LE(now.day, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    offset += local.length + name.length + data.length
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  fs.writeFileSync(outputPath, Buffer.concat([...chunks, ...central, end]))
  return { filePath: outputPath, files: files.length }
}

module.exports = {
  clearArtifacts,
  previewText,
  removeArtifact,
  resolveArtifactPath,
  zipDirectory,
  writeResultArtifacts,
}
