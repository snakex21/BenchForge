const { spawn } = require('child_process')

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_STDERR = 64 * 1024

function sanitizeServers(servers) {
  return (Array.isArray(servers) ? servers : [])
    .filter((server) => server && typeof server === 'object' && server.id && server.command && !server.disabled)
    .map((server) => ({
      id: String(server.id),
      name: String(server.name || server.id),
      command: String(server.command),
      args: Array.isArray(server.args) ? server.args.map(String) : [],
      cwd: server.cwd ? String(server.cwd) : undefined,
      env: server.env && typeof server.env === 'object' ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, String(value)])) : {},
      timeoutMs: Math.max(1000, Math.min(120000, Number(server.timeoutMs || DEFAULT_TIMEOUT_MS))),
    }))
}

function findHeaderEnd(buffer) {
  return buffer.indexOf(Buffer.from('\r\n\r\n'))
}

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf-8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

function createStdioClient(server) {
  const child = spawn(server.command, server.args || [], {
    cwd: server.cwd || undefined,
    env: { ...process.env, ...(server.env || {}) },
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let nextId = 1
  let stdoutBuffer = Buffer.alloc(0)
  let stderr = ''
  const pending = new Map()

  const closeWithError = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
    while (true) {
      const headerEnd = findHeaderEnd(stdoutBuffer)
      if (headerEnd < 0) return
      const header = stdoutBuffer.slice(0, headerEnd).toString('ascii')
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        stdoutBuffer = stdoutBuffer.slice(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const messageStart = headerEnd + 4
      const messageEnd = messageStart + length
      if (stdoutBuffer.length < messageEnd) return
      const body = stdoutBuffer.slice(messageStart, messageEnd).toString('utf-8')
      stdoutBuffer = stdoutBuffer.slice(messageEnd)
      let message = null
      try { message = JSON.parse(body) } catch { continue }
      if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
        const waiter = pending.get(message.id)
        if (!waiter) continue
        pending.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)))
        else waiter.resolve(message.result)
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString('utf-8')}`.slice(-MAX_STDERR)
  })

  child.on('error', (error) => closeWithError(error))
  child.on('close', (code) => {
    if (pending.size > 0) closeWithError(new Error(`MCP server exited with code ${code}. ${stderr}`.trim()))
  })

  const send = (message) => child.stdin.write(encodeMessage(message))
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
  const request = (method, params, timeoutMs = server.timeoutMs || DEFAULT_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`MCP request timed out: ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    send({ jsonrpc: '2.0', id, method, params })
  })
  const close = () => {
    try { child.kill('SIGTERM') } catch {}
    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 500)
  }
  return { request, notify, close, stderr: () => stderr }
}

async function withInitializedClient(server, fn) {
  const client = createStdioClient(server)
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'BenchForge', version: '1.0.0' },
    })
    client.notify('notifications/initialized', {})
    return await fn(client)
  } finally {
    client.close()
  }
}

async function listMcpTools(servers) {
  const activeServers = sanitizeServers(servers)
  const results = []
  for (const server of activeServers) {
    try {
      const payload = await withInitializedClient(server, (client) => client.request('tools/list', {}))
      const tools = Array.isArray(payload?.tools) ? payload.tools : []
      results.push({ server: { id: server.id, name: server.name }, ok: true, tools })
    } catch (error) {
      results.push({ server: { id: server.id, name: server.name }, ok: false, error: error instanceof Error ? error.message : String(error), tools: [] })
    }
  }
  return results
}

async function callMcpTool(servers, serverId, toolName, args = {}) {
  const server = sanitizeServers(servers).find((item) => item.id === serverId)
  if (!server) throw new Error(`MCP server not found or disabled: ${serverId}`)
  return withInitializedClient(server, async (client) => {
    const result = await client.request('tools/call', { name: toolName, arguments: args || {} })
    return { ok: true, server: { id: server.id, name: server.name }, toolName, result }
  })
}

module.exports = { sanitizeServers, listMcpTools, callMcpTool }
