const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { app } = require('electron')
const { callMcpTool, listMcpTools } = require('./mcpRuntime.cjs')

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 256 * 1024

const TOOL_DEFS = [
  { id: 'python.run', name: 'Python runner', description: 'Runs Python code in an isolated temporary artifact folder with timeout and best-effort network blocking.' },
  { id: 'node.run', name: 'Node runner', description: 'Runs JavaScript code in an isolated temporary artifact folder with timeout and best-effort network blocking.' },
  { id: 'file.write', name: 'Write file', description: 'Writes a file inside the tool workdir.' },
  { id: 'file.read', name: 'Read file', description: 'Reads a file from the tool workdir.' },
  { id: 'file.list', name: 'List files', description: 'Lists files created in the tool workdir.' },
  { id: 'image.draw_path_svg', name: 'Draw path SVG', description: 'Creates an SVG overlay/path artifact for image/maze tasks.' },
  { id: 'mcp.list_tools', name: 'List MCP tools', description: 'Lists tools exposed by configured MCP servers.' },
  { id: 'mcp.call', name: 'Call MCP tool', description: 'Calls a tool on a configured MCP server through stdio JSON-RPC.' },
]

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/')
}

function getUserDataPath() {
  return app.getPath('userData')
}

function artifactsRelativePath(...parts) {
  return toPosix(path.join('artifacts', 'tools', ...parts))
}

function resolveUserDataPath(relativePath) {
  const userData = path.resolve(getUserDataPath())
  const absolute = path.resolve(userData, relativePath)
  const relative = path.relative(userData, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function createToolRun() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runId = `tool-run-${stamp}-${Math.random().toString(36).slice(2, 8)}`
  const relativePath = artifactsRelativePath(runId)
  const absolutePath = resolveUserDataPath(relativePath)
  ensureDir(absolutePath)
  fs.writeFileSync(path.join(absolutePath, 'tool-calls.jsonl'), '', 'utf-8')
  return { runId, relativePath, absolutePath }
}

function resolveWorkdir(relativePath) {
  if (!relativePath) return createToolRun()
  const absolutePath = resolveUserDataPath(relativePath)
  if (!absolutePath) throw new Error('Invalid tool workdir')
  ensureDir(absolutePath)
  const runId = path.basename(absolutePath)
  const tracePath = path.join(absolutePath, 'tool-calls.jsonl')
  if (!fs.existsSync(tracePath)) fs.writeFileSync(tracePath, '', 'utf-8')
  return { runId, relativePath: toPosix(relativePath), absolutePath }
}

function safeChildPath(workdir, requestedPath, fallbackName = 'file.txt') {
  const rel = String(requestedPath || fallbackName).replace(/^[/\\]+/, '')
  const absolute = path.resolve(workdir, rel)
  const relative = path.relative(workdir, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes tool workdir')
  return absolute
}

function appendTrace(run, entry) {
  const trace = { ts: new Date().toISOString(), ...entry }
  fs.appendFileSync(path.join(run.absolutePath, 'tool-calls.jsonl'), `${JSON.stringify(trace)}\n`, 'utf-8')
}

function clampTimeout(timeoutMs) {
  const value = Number(timeoutMs || DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(value)))
}

function trimOutput(value) {
  const text = String(value || '')
  if (Buffer.byteLength(text, 'utf-8') <= MAX_OUTPUT_BYTES) return text
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n...[truncated]`
}

function runProcess(command, args, options) {
  const timeoutMs = clampTimeout(options.timeoutMs)
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ...options.env,
        BENCHFORGE_SANDBOX: '1',
        NO_PROXY: '*',
        no_proxy: '*',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout = trimOutput(stdout + chunk.toString('utf-8')) })
    child.stderr.on('data', (chunk) => { stderr = trimOutput(stderr + chunk.toString('utf-8')) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, exitCode: null, timedOut, stdout, stderr: `${stderr}\n${error.message}`.trim(), durationMs: Date.now() - startedAt })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && !timedOut, exitCode: code, timedOut, stdout, stderr, durationMs: Date.now() - startedAt })
    })
    if (options.input) child.stdin.write(options.input)
    child.stdin.end()
  })
}

function pythonBootstrap(userFileName) {
  return `
import builtins
import os
import socket
import sys

class BenchForgeNetworkBlocked(RuntimeError):
    pass

def _blocked(*args, **kwargs):
    raise BenchForgeNetworkBlocked('Network access is blocked by BenchForge tool runtime')

socket.socket = _blocked
socket.create_connection = _blocked

_real_import = builtins.__import__
_blocked_modules = {'urllib', 'http', 'ftplib', 'smtplib', 'poplib', 'imaplib', 'telnetlib', 'socketserver', 'requests', 'aiohttp', 'websocket'}
def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split('.')[0]
    if root in _blocked_modules:
        raise ImportError(f'Module {name} is blocked by BenchForge tool runtime')
    return _real_import(name, globals, locals, fromlist, level)
builtins.__import__ = _guarded_import

with open(${JSON.stringify(userFileName)}, 'r', encoding='utf-8') as _benchforge_file:
    _code = compile(_benchforge_file.read(), ${JSON.stringify(userFileName)}, 'exec')
exec(_code, {'__name__': '__main__', '__file__': ${JSON.stringify(userFileName)}})
`.trimStart()
}

function nodeBootstrap(userFileName) {
  return `
const Module = require('module')
const blocked = new Set(['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'child_process', 'cluster'])
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (blocked.has(request)) throw new Error('Module ' + request + ' is blocked by BenchForge tool runtime')
  return originalLoad.apply(this, arguments)
}
global.fetch = async function() { throw new Error('Network access is blocked by BenchForge tool runtime') }
require(${JSON.stringify(`./${userFileName}`)})
`.trimStart()
}

async function runPython(input, run) {
  const code = String(input.code || '')
  const userFile = 'main.py'
  const bootstrapFile = '__benchforge_bootstrap.py'
  fs.writeFileSync(path.join(run.absolutePath, userFile), code, 'utf-8')
  fs.writeFileSync(path.join(run.absolutePath, bootstrapFile), pythonBootstrap(userFile), 'utf-8')
  if (input.useDocker) {
    const volume = `${run.absolutePath.replace(/\\/g, '/')}:/workspace`
    const result = await runProcess('docker', ['run', '--rm', '--network', 'none', '-v', volume, '-w', '/workspace', input.pythonImage || 'python:3.12-alpine', 'python', bootstrapFile], { cwd: run.absolutePath, timeoutMs: input.timeoutMs, input: input.stdin || '' })
    fs.writeFileSync(path.join(run.absolutePath, 'stdout.txt'), result.stdout || '', 'utf-8')
    fs.writeFileSync(path.join(run.absolutePath, 'stderr.txt'), result.stderr || '', 'utf-8')
    return { ...result, docker: true, image: input.pythonImage || 'python:3.12-alpine' }
  }

  const explicit = input.pythonPath ? [{ command: input.pythonPath, args: [bootstrapFile] }] : []
  const candidates = [...explicit, { command: 'python', args: [bootstrapFile] }, { command: 'py', args: ['-3', bootstrapFile] }, { command: 'python3', args: [bootstrapFile] }]
  let result = null
  for (const candidate of candidates) {
    result = await runProcess(candidate.command, candidate.args, { cwd: run.absolutePath, timeoutMs: input.timeoutMs, input: input.stdin || '' })
    const stderr = String(result.stderr || '').toLowerCase()
    const commandMissing = result.exitCode === null && (stderr.includes('enoent') || stderr.includes('not recognized') || stderr.includes('nie jest rozpoznaw'))
    if (!commandMissing) break
  }
  fs.writeFileSync(path.join(run.absolutePath, 'stdout.txt'), result.stdout || '', 'utf-8')
  fs.writeFileSync(path.join(run.absolutePath, 'stderr.txt'), result.stderr || '', 'utf-8')
  return result
}

async function runNode(input, run) {
  const code = String(input.code || '')
  const userFile = 'main.js'
  const bootstrapFile = '__benchforge_bootstrap.cjs'
  fs.writeFileSync(path.join(run.absolutePath, userFile), code, 'utf-8')
  fs.writeFileSync(path.join(run.absolutePath, bootstrapFile), nodeBootstrap(userFile), 'utf-8')
  if (input.useDocker) {
    const volume = `${run.absolutePath.replace(/\\/g, '/')}:/workspace`
    const result = await runProcess('docker', ['run', '--rm', '--network', 'none', '-v', volume, '-w', '/workspace', input.nodeImage || 'node:22-alpine', 'node', bootstrapFile], { cwd: run.absolutePath, timeoutMs: input.timeoutMs, input: input.stdin || '' })
    fs.writeFileSync(path.join(run.absolutePath, 'stdout.txt'), result.stdout || '', 'utf-8')
    fs.writeFileSync(path.join(run.absolutePath, 'stderr.txt'), result.stderr || '', 'utf-8')
    return { ...result, docker: true, image: input.nodeImage || 'node:22-alpine' }
  }
  const usesExplicitNode = Boolean(input.nodePath)
  const result = await runProcess(input.nodePath || process.execPath, [bootstrapFile], { cwd: run.absolutePath, timeoutMs: input.timeoutMs, input: input.stdin || '', env: usesExplicitNode ? {} : { ELECTRON_RUN_AS_NODE: '1' } })
  fs.writeFileSync(path.join(run.absolutePath, 'stdout.txt'), result.stdout || '', 'utf-8')
  fs.writeFileSync(path.join(run.absolutePath, 'stderr.txt'), result.stderr || '', 'utf-8')
  return result
}

function writeFileTool(input, run) {
  const target = safeChildPath(run.absolutePath, input.path, 'file.txt')
  ensureDir(path.dirname(target))
  fs.writeFileSync(target, String(input.content ?? ''), input.encoding || 'utf-8')
  return { ok: true, path: toPosix(path.relative(run.absolutePath, target)), bytes: fs.statSync(target).size }
}

function readFileTool(input, run) {
  const target = safeChildPath(run.absolutePath, input.path, 'file.txt')
  const content = fs.readFileSync(target, input.encoding || 'utf-8')
  return { ok: true, path: toPosix(path.relative(run.absolutePath, target)), content: trimOutput(content) }
}

function listFilesTool(_input, run) {
  const files = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const rel = toPosix(path.relative(run.absolutePath, absolute))
      if (entry.isDirectory()) walk(absolute)
      else files.push({ path: rel, bytes: fs.statSync(absolute).size })
    }
  }
  walk(run.absolutePath)
  return { ok: true, files }
}

function normalizePoints(points) {
  if (!Array.isArray(points)) return []
  return points
    .map((point) => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [Number(point?.x), Number(point?.y)])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
}

function drawPathSvgTool(input, run) {
  const points = normalizePoints(input.points || input.pathPoints)
  const width = Number(input.width || 512)
  const height = Number(input.height || 512)
  const polyline = points.map(([x, y]) => `${x},${y}`).join(' ')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <polyline points="${polyline}" fill="none" stroke="#ef4444" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  ${points.map(([x, y], index) => `<circle cx="${x}" cy="${y}" r="${index === 0 || index === points.length - 1 ? 7 : 3}" fill="${index === 0 ? '#22c55e' : index === points.length - 1 ? '#3b82f6' : '#ef4444'}"/>`).join('\n  ')}
</svg>`
  const fileName = input.outputPath || 'path-overlay.svg'
  const target = safeChildPath(run.absolutePath, fileName, 'path-overlay.svg')
  fs.writeFileSync(target, svg, 'utf-8')
  return { ok: true, path: toPosix(path.relative(run.absolutePath, target)), points: points.length }
}

async function listMcpToolsTool(input) {
  const servers = input.mcpServers || input.servers || []
  const result = await listMcpTools(servers)
  return { ok: true, servers: result }
}

async function callMcpToolTool(input) {
  const servers = input.mcpServers || input.servers || []
  const serverId = String(input.serverId || input.server_id || '')
  const toolName = String(input.toolName || input.tool_name || input.name || '')
  if (!serverId || !toolName) throw new Error('mcp.call requires serverId and toolName')
  return callMcpTool(servers, serverId, toolName, input.arguments || input.args || {})
}

async function runTool(payload = {}) {
  const tool = String(payload.tool || payload.id || '')
  const run = resolveWorkdir(payload.workdir)
  const input = payload.input || payload
  appendTrace(run, { tool, phase: 'start', input: { ...input, code: input.code ? `[${String(input.code).length} chars]` : undefined } })
  let result
  try {
    if (tool === 'python.run') result = await runPython(input, run)
    else if (tool === 'node.run') result = await runNode(input, run)
    else if (tool === 'file.write') result = writeFileTool(input, run)
    else if (tool === 'file.read') result = readFileTool(input, run)
    else if (tool === 'file.list') result = listFilesTool(input, run)
    else if (tool === 'image.draw_path_svg') result = drawPathSvgTool(input, run)
    else if (tool === 'mcp.list_tools') result = await listMcpToolsTool({ ...input, mcpServers: payload.mcpServers || input.mcpServers })
    else if (tool === 'mcp.call') result = await callMcpToolTool({ ...input, mcpServers: payload.mcpServers || input.mcpServers })
    else throw new Error(`Unknown tool: ${tool}`)
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  appendTrace(run, { tool, phase: 'done', result })
  fs.writeFileSync(path.join(run.absolutePath, 'last-result.json'), JSON.stringify({ tool, result, workdir: run.relativePath }, null, 2), 'utf-8')
  return { ...result, workdir: run.relativePath, tracePath: toPosix(path.join(run.relativePath, 'tool-calls.jsonl')) }
}

function listTools() {
  return TOOL_DEFS
}

module.exports = { listTools, runTool }
