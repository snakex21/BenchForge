const fs = require('fs')
const path = require('path')
const { resolveArtifactPath } = require('./artifacts.cjs')
const { listTools, runTool } = require('./toolRuntime.cjs')

const DEFAULT_ALLOWED_TOOLS = ['python.run', 'node.run', 'file.write', 'file.read', 'file.list', 'image.draw_path_svg', 'mcp.list_tools', 'mcp.call']

function parseJsonLike(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [raw, fenced?.[1]].filter(Boolean)
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) } catch {}
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)) } catch {}
    }
  }
  return null
}

function parseToolSpec(task, benchmark) {
  const value = task?.pass_condition || benchmark?.pass_condition || ''
  try {
    const parsed = JSON.parse(value || '{}')
    if (parsed?.allowed_tools || String(parsed?.mode || '').startsWith('tool_')) {
      return {
        mode: parsed.mode || 'tool_agent',
        allowedTools: Array.isArray(parsed.allowed_tools) && parsed.allowed_tools.length ? parsed.allowed_tools.map(String) : DEFAULT_ALLOWED_TOOLS,
        deniedTools: Array.isArray(parsed.denied_tools) ? parsed.denied_tools.map(String) : [],
        mcpAllowedTools: Array.isArray(parsed.mcp_allowed_tools) ? parsed.mcp_allowed_tools.map(String) : [],
        mcpDeniedTools: Array.isArray(parsed.mcp_denied_tools) ? parsed.mcp_denied_tools.map(String) : [],
        maxCalls: Math.max(1, Math.min(30, Number(parsed.max_calls || 8))),
        timeoutMs: Math.max(1000, Math.min(120000, Number(parsed.timeout_ms || 10000))),
        spec: parsed,
      }
    }
  } catch {}
  return null
}

function isToolTask(task, benchmark) {
  return Boolean(parseToolSpec(task, benchmark))
}

function toolProtocolPrompt({ task, benchmark, spec, allowedTools }) {
  const toolDescriptions = listTools()
    .filter((tool) => allowedTools.includes(tool.id))
    .map((tool) => `- ${tool.id}: ${tool.description}`)
    .join('\n')

  return `
You are solving a BenchForge tool benchmark.

You may use tools. Do not pretend to use a tool. To call a tool, respond with ONLY valid JSON in this shape:
{"tool_call":{"tool":"python.run","input":{"code":"print('hello')","timeoutMs":10000}}}

After BenchForge returns TOOL_RESULT, continue. When finished, respond with ONLY valid JSON in this shape:
{"final_answer":"short final answer", "path": [[0,0],[1,0]], "artifacts": ["path.json", "path-overlay.svg"]}

Allowed tools:
${toolDescriptions}

Denied tools:
${spec.deniedTools?.length ? spec.deniedTools.map((tool) => `- ${tool}`).join('\n') : '- none'}

MCP tool name allow/deny:
- allowed MCP tool names: ${spec.mcpAllowedTools?.length ? spec.mcpAllowedTools.join(', ') : 'any'}
- denied MCP tool names: ${spec.mcpDeniedTools?.length ? spec.mcpDeniedTools.join(', ') : 'none'}

Important tool notes:
- python.run and node.run execute in a temporary workdir and return stdout/stderr.
- file.write writes files inside the same workdir when you pass the same workdir through tool calls automatically.
- image.draw_path_svg accepts {"points":[[x,y],...],"width":512,"height":512,"outputPath":"path-overlay.svg"}.
- For maze tasks, also create path.json with {"path": [[x,y], ...]} using file.write or python code.

Benchmark: ${benchmark.name}
Task: ${task.name || benchmark.name}
Task prompt:
${task.prompt_template || benchmark.prompt_template}

Tool benchmark metadata:
${JSON.stringify(spec.spec || spec, null, 2)}
`.trim()
}

function summarizeToolResult(result) {
  const clone = { ...result }
  if (typeof clone.stdout === 'string' && clone.stdout.length > 4000) clone.stdout = `${clone.stdout.slice(0, 4000)}...[truncated]`
  if (typeof clone.stderr === 'string' && clone.stderr.length > 4000) clone.stderr = `${clone.stderr.slice(0, 4000)}...[truncated]`
  return clone
}

function readPathFromWorkdir(workdir) {
  const absolute = resolveArtifactPath(path.join(workdir, 'path.json'))
  if (!absolute || !fs.existsSync(absolute)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(absolute, 'utf-8'))
    return Array.isArray(parsed?.path) ? parsed.path : Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizePoints(points) {
  if (!Array.isArray(points)) return []
  return points
    .map((point) => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [Number(point?.x), Number(point?.y)])
    .filter(([x, y]) => Number.isInteger(x) && Number.isInteger(y))
}

function verifyGridPath(points, spec) {
  const grid = Array.isArray(spec.grid) ? spec.grid.map(String) : []
  const start = Array.isArray(spec.start) ? [Number(spec.start[0]), Number(spec.start[1])] : null
  const end = Array.isArray(spec.end) ? [Number(spec.end[0]), Number(spec.end[1])] : null
  const pathPoints = normalizePoints(points)
  if (!grid.length || !start || !end) return { passed: pathPoints.length > 0, reason: 'No grid metadata; path existence only', pathPoints }
  if (pathPoints.length === 0) return { passed: false, reason: 'No path points', pathPoints }
  const [sx, sy] = start
  const [ex, ey] = end
  const first = pathPoints[0]
  const last = pathPoints[pathPoints.length - 1]
  if (first[0] !== sx || first[1] !== sy) return { passed: false, reason: 'Path does not start at S', pathPoints }
  if (last[0] !== ex || last[1] !== ey) return { passed: false, reason: 'Path does not end at E', pathPoints }
  for (let i = 0; i < pathPoints.length; i++) {
    const [x, y] = pathPoints[i]
    if (y < 0 || y >= grid.length || x < 0 || x >= grid[y].length) return { passed: false, reason: `Point out of bounds at ${i}`, pathPoints }
    if (grid[y][x] === '#') return { passed: false, reason: `Path hits wall at ${x},${y}`, pathPoints }
    if (i > 0) {
      const [px, py] = pathPoints[i - 1]
      const dist = Math.abs(px - x) + Math.abs(py - y)
      if (dist !== 1) return { passed: false, reason: `Non-adjacent step at ${i}`, pathPoints }
    }
  }
  return { passed: true, reason: 'Path is valid', pathPoints }
}

async function runToolAgent({ provider, model, benchmark, task, sendEvent, signal, mcpServers = [] }) {
  const spec = parseToolSpec(task, benchmark)
  if (!spec) throw new Error('Task is not configured for tool agent mode')
  const allowedTools = spec.allowedTools
  const deniedTools = spec.deniedTools || []
  const transcript = []
  let workdir = null
  let finalAnswer = null
  let tokensUsed = 0
  let lastModelResponse = ''

  transcript.push({ role: 'system', content: toolProtocolPrompt({ task, benchmark, spec, allowedTools }) })

  for (let step = 1; step <= spec.maxCalls + 1; step++) {
    if (signal?.aborted) throw new Error('Benchmark anulowany przez użytkownika.')
    const prompt = transcript.map((item) => `${item.role.toUpperCase()}:\n${item.content}`).join('\n\n---\n\n')
    const modelResult = await provider.sendPrompt(model, prompt, task.output_type === 'maze' ? task.reference_image : null)
    tokensUsed += Number(modelResult.tokens_used) || 0
    lastModelResponse = modelResult.response || ''
    const parsed = parseJsonLike(lastModelResponse)

    if (parsed?.tool_call?.tool) {
      const tool = String(parsed.tool_call.tool)
      const input = parsed.tool_call.input && typeof parsed.tool_call.input === 'object' ? parsed.tool_call.input : {}
      const mcpToolName = tool === 'mcp.call' ? String(input.toolName || input.tool_name || input.name || '') : ''
      const mcpBlocked = tool === 'mcp.call' && ((spec.mcpAllowedTools?.length && !spec.mcpAllowedTools.includes(mcpToolName)) || spec.mcpDeniedTools?.includes(mcpToolName))
      if (!allowedTools.includes(tool) || deniedTools.includes(tool) || mcpBlocked) {
        const toolResult = { ok: false, error: mcpBlocked ? `MCP tool ${mcpToolName} is not allowed` : `Tool ${tool} is not allowed`, allowedTools, deniedTools, mcpAllowedTools: spec.mcpAllowedTools, mcpDeniedTools: spec.mcpDeniedTools }
        transcript.push({ role: 'assistant', content: lastModelResponse })
        transcript.push({ role: 'tool', content: `TOOL_RESULT:\n${JSON.stringify(toolResult, null, 2)}` })
        sendEvent?.('task:tool-call', { benchmarkId: benchmark.id, taskId: task.id, step, tool, result: toolResult, workdir })
        continue
      }
      const toolResult = await runTool({ tool, workdir, mcpServers, input: { timeoutMs: spec.timeoutMs, ...input } })
      workdir = toolResult.workdir || workdir
      const summarized = summarizeToolResult(toolResult)
      sendEvent?.('task:tool-call', { benchmarkId: benchmark.id, taskId: task.id, step, tool, result: summarized, workdir })
      transcript.push({ role: 'assistant', content: lastModelResponse })
      transcript.push({ role: 'tool', content: `TOOL_RESULT:\n${JSON.stringify(summarized, null, 2)}` })
      continue
    }

    finalAnswer = parsed?.final_answer || parsed?.answer || lastModelResponse
    break
  }

  const finalParsed = parseJsonLike(lastModelResponse) || {}
  const pathFromAnswer = finalParsed.path || finalParsed?.final?.path || null
  const pathFromFile = workdir ? readPathFromWorkdir(workdir) : null
  const pathPoints = pathFromFile || pathFromAnswer || []
  const verification = spec.mode === 'tool_maze_path' ? verifyGridPath(pathPoints, spec.spec) : { passed: Boolean(finalAnswer || lastModelResponse), reason: 'Tool agent produced final answer', pathPoints: normalizePoints(pathPoints) }
  if (verification.passed && workdir && Array.isArray(spec.spec.required_artifacts)) {
    const missing = spec.spec.required_artifacts.filter((artifact) => {
      const absolute = resolveArtifactPath(path.join(workdir, String(artifact)))
      return !absolute || !fs.existsSync(absolute)
    })
    if (missing.length > 0) {
      verification.passed = false
      verification.reason = `Missing required artifacts: ${missing.join(', ')}`
    }
  }
  const trace = transcript.map((item) => `${item.role.toUpperCase()}:\n${item.content}`).join('\n\n---\n\n')
  const response = JSON.stringify({
    final_answer: finalAnswer,
    verification,
    workdir,
    path: verification.pathPoints,
    last_model_response: lastModelResponse,
  }, null, 2)

  return {
    response,
    thinking: trace,
    score: verification.passed ? 'tak' : 'nie',
    tokens_used: tokensUsed || null,
    workdir,
    verification,
  }
}

module.exports = { isToolTask, parseToolSpec, runToolAgent }
