const { getModelById, getBenchmarkById, getTasks, addResult, getLatestTaskResult, createRunSession, getRunSession, updateRunSession, finishRunSession, cancelRunSession, getPreference } = require('./database.cjs')
const { getProvider } = require('./providers/index.cjs')
const { isToolTask, runToolAgent } = require('./toolAgent.cjs')
const { evaluateSandbox } = require('./sandboxEvaluator.cjs')

function extractExpectedAnswers(benchmark) {
  const candidates = []
  const condition = String(benchmark.pass_condition || '')
  const checklist = Array.isArray(benchmark.evaluation_checklist) ? benchmark.evaluation_checklist.join('\n') : ''
  const source = `${condition}\n${checklist}`

  for (const pattern of [
    /poprawna odpowied[źz]\s+to\s+([^\.\n]+)/i,
    /odpowied[źz]\s+to\s+([^\.\n]+)/i,
    /zawiera\s+([^\.\n]+)/i,
  ]) {
    const match = source.match(pattern)
    if (match?.[1]) candidates.push(match[1])
  }

  return candidates
    .map((value) => String(value).replace(/["'`]/g, '').trim().toLowerCase())
    .filter(Boolean)
}

function evaluateBooleanResponse(benchmark, response) {
  const normalized = String(response || '').trim().toLowerCase()
  if (/\btak\b/.test(normalized)) return 'tak'
  if (/\bnie\b/.test(normalized)) return 'nie'

  const expectedAnswers = extractExpectedAnswers(benchmark)
  if (expectedAnswers.length > 0) {
    return expectedAnswers.some((expected) => normalized.includes(expected)) ? 'tak' : 'nie'
  }

  return null
}

function evaluateNumericResponse(response) {
  const match = String(response || '').match(/\b(100|\d{1,2})(?:\s*%)?\b/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isNaN(value) ? null : Math.max(0, Math.min(100, value))
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasExactDeclaration(text, identifier) {
  const id = escapeRegex(identifier)
  const boundary = '[^a-z0-9_$]'
  const declarationPatterns = [
    new RegExp(`(^|${boundary})(?:def|function|func|fun|fn|class|struct|interface|trait|protocol)\\s+${id}(?=$|${boundary})`, 'i'),
    new RegExp(`(^|${boundary})(?:const|let|var)\\s+${id}\\s*=`, 'i'),
    new RegExp(`(^|${boundary})(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+|inline\\s+|constexpr\\s+|async\\s+)*(?:[a-z_$][\\w$:<>,\\[\\]\\*&?]*\\s+)+${id}\\s*\\(`, 'i'),
  ]
  return declarationPatterns.some((pattern) => pattern.test(text))
}

function hasPrefixedBadDeclaration(text, identifier) {
  const id = escapeRegex(identifier)
  const boundary = '[^a-z0-9_$]'
  const badIdentifier = `${id}[a-z0-9_$]+`
  const badPatterns = [
    new RegExp(`(^|${boundary})(?:def|function|func|fun|fn|class|struct|interface|trait|protocol)\\s+${badIdentifier}(?=$|${boundary})`, 'i'),
    new RegExp(`(^|${boundary})(?:const|let|var)\\s+${badIdentifier}\\s*=`, 'i'),
    new RegExp(`(^|${boundary})(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+|inline\\s+|constexpr\\s+|async\\s+)*(?:[a-z_$][\\w$:<>,\\[\\]\\*&?]*\\s+)+${badIdentifier}\\s*\\(`, 'i'),
  ]
  return badPatterns.some((pattern) => pattern.test(text))
}

function matchesRequiredCodeFragment(text, required) {
  const needle = String(required || '').trim().toLowerCase()
  if (!needle) return false

  if (needle === 'seen' && (/\bwidziane\b/i.test(text) || /\bseen\b/i.test(text) || /\bset\s*\(/i.test(text) || /dict\.fromkeys/i.test(text))) {
    return true
  }

  // If the condition is a single code identifier (e.g. "greet", "is_even", "String"),
  // match it as a full identifier. This prevents false positives like "greet0" satisfying "greet".
  if (/^[a-z_$][\w$]*$/i.test(needle)) {
    // Method calls like ".reverse()" are valid occurrences even when another function name
    // contains the same prefix, e.g. "reverseString".
    const methodAccessPattern = new RegExp(`\\.\\s*${escapeRegex(needle)}(?=$|[^a-z0-9_$])`, 'i')
    if (methodAccessPattern.test(text)) return true

    if (hasPrefixedBadDeclaration(text, needle) && !hasExactDeclaration(text, needle)) return false
    const identifierPattern = new RegExp(`(^|[^a-z0-9_$])${escapeRegex(needle)}(?=$|[^a-z0-9_$])`, 'i')
    return identifierPattern.test(text)
  }

  // If the condition looks like a declaration fragment ending with an identifier,
  // e.g. "def first_element", "func greet", "function countWords", ensure the final
  // identifier is not just a prefix of a longer name like "first_element0".
  const declarationMatch = needle.match(/^((?:def|function|func|fun|fn|class|struct|interface|trait|protocol)\s+)([a-z_$][\w$]*)$/i)
  if (declarationMatch) {
    const [, prefix, identifier] = declarationMatch
    const declarationPattern = new RegExp(`(^|[^a-z0-9_$])${escapeRegex(prefix)}${escapeRegex(identifier)}(?=$|[^a-z0-9_$])`, 'i')
    return declarationPattern.test(text)
  }

  // More specific fragments like "func greet(" or "% 2" use normal contains.
  return text.includes(needle)
}

function evaluateCodePresenceBenchmark(benchmark, response) {
  try {
    const parsed = JSON.parse(benchmark.pass_condition || '{}')
    if (parsed?.mode !== 'code_presence') return null

    const text = String(response || '').toLowerCase()
    if (!text.trim()) return { score: 0, error: 'The model finished generation without a response.', passed: 0, total: 1 }
    if (Array.isArray(parsed.required)) {
      const required = parsed.required.map((needle) => String(needle || '').trim()).filter(Boolean)
      if (required.length === 0) return { score: 0, error: 'The code_presence condition has no required fragments.', passed: 0, total: 1 }
      const missing = required.filter((needle) => !matchesRequiredCodeFragment(text, needle))
      const ok = missing.length === 0
      return {
        score: ok ? 100 : 0,
        error: ok ? null : `Missing required fragments: ${missing.join(', ')}`,
        passed: ok ? 1 : 0,
        total: 1,
      }
    }
    return null
  } catch {
    return null
  }
}

async function evaluateScore(benchmark, response, options = {}) {
  if (benchmark.output_type === 'maze') return { score: null, is_manual: false, needs_verify: true, error: null }
  if (!String(response || '').trim()) return { score: 0, error: 'The model finished generation without a response.' }
  const sandbox = await evaluateSandbox(benchmark, response, options)
  if (sandbox) return sandbox
  const codePresence = evaluateCodePresenceBenchmark(benchmark, response)
  if (codePresence) return codePresence
  if (benchmark.output_type && benchmark.output_type !== 'text') return { score: null, is_manual: true, error: null }

  if (benchmark.score_type === 'boolean') {
    const score = evaluateBooleanResponse(benchmark, response)
    return score ? { score, error: null } : { score: null, error: 'Could not evaluate the model response for a boolean benchmark.' }
  }

  const score = evaluateNumericResponse(response)
  return score === null ? { score: null, error: 'Could not read a numeric score from the model response.' } : { score, error: null }
}

function normalizeBenchmarkScore(benchmark, score, attempt, attempts) {
  if (benchmark.score_type === 'boolean') return score
  const value = Math.max(0, Math.min(100, Number(score) || 0))
  return Math.round(value * (attempts - attempt + 1) / attempts)
}

function isStaleLegacyTask(task, benchmark, taskCount) {
  if (!task || !benchmark || taskCount <= 1) return false
  const taskPrompt = String(task.prompt_template || '').trim()
  const benchmarkPrompt = String(benchmark.prompt_template || '').trim()
  if (!taskPrompt || !benchmarkPrompt || taskPrompt !== benchmarkPrompt) return false
  const genericName = /^Zadanie\s+1$/i.test(String(task.name || '').trim())
  const sameAsParentCondition = String(task.pass_condition || '').trim() === String(benchmark.pass_condition || '').trim()
  const hasNoOwnAnswer = !task.expected_answer && !task.pass_condition && (!Array.isArray(task.evaluation_checklist) || task.evaluation_checklist.length === 0)

  return genericName && (sameAsParentCondition || hasNoOwnAnswer)
}

function getRunnableTasks(benchmarkId, benchmark) {
  const tasks = getTasks(benchmarkId)
  const filteredTasks = tasks.filter((task) => !isStaleLegacyTask(task, benchmark, tasks.length))
  return filteredTasks.length > 0 ? filteredTasks : [{ ...benchmark, id: null, benchmark_id: benchmarkId, name: benchmark.name, order_index: 0 }]
}

function aggregateBenchmarkScore(benchmark, taskResults) {
  const scores = taskResults
    .map((item) => item.score)
    .filter((score) => score !== null && score !== undefined)

  if (scores.length === 0) return null
  if (benchmark.score_type === 'boolean') return scores.every((score) => String(score).toLowerCase() === 'tak') ? 'tak' : 'nie'

  const numericScores = scores.map(Number).filter((value) => !Number.isNaN(value))
  if (numericScores.length === 0) return null
  return Number((numericScores.reduce((sum, value) => sum + value, 0) / numericScores.length).toFixed(2))
}

function buildBenchmarkNotes(taskResults, runnableTasks) {
  if (taskResults.length === 1) return taskResults[0].response || ''
  return taskResults.map((result, index) => {
    const task = runnableTasks.find((item) => item.id === result.task_id)
    const title = task?.name || `Zadanie ${index + 1}`
    return `## ${index + 1}. ${title}\nWynik: ${result.score ?? '—'}\n\n${result.response || ''}`
  }).join('\n\n---\n\n')
}

function buildBenchmarkThinkingNotes(taskResults, runnableTasks) {
  const withThinking = taskResults.filter((result) => String(result.thinking || '').trim())
  if (withThinking.length === 0) return null
  if (taskResults.length === 1) return withThinking[0]?.thinking || null
  return taskResults.map((result, index) => {
    const task = runnableTasks.find((item) => item.id === result.task_id)
    const title = task?.name || `Zadanie ${index + 1}`
    return `## ${index + 1}. ${title}\n\n${result.thinking || '_No saved thinking._'}`
  }).join('\n\n---\n\n')
}

function normalizeProvidedScore(score, scoreType) {
  if (score === null || score === undefined) return null
  const text = String(score).trim().toLowerCase()
  if (!text) return null

  if (scoreType === 'boolean') {
    if (['tak', 'yes', 'true', 'pass', 'passed', 'ok', '1'].includes(text)) return 'tak'
    if (['nie', 'no', 'false', 'fail', 'failed', '0'].includes(text)) return 'nie'
    return null
  }

  const match = text.match(/-?\d+(?:[\.,]\d+)?/)
  if (!match) return null
  const numeric = Number(match[0].replace(',', '.'))
  return Number.isNaN(numeric) ? null : Math.max(0, Math.min(100, numeric))
}

function resolveBatchTask(entry, runnableTasks) {
  const rawTaskId = entry.taskId ?? entry.task_id ?? entry.id
  const numericTaskId = rawTaskId === null || rawTaskId === undefined || rawTaskId === '' ? null : Number(rawTaskId)
  if (Number.isFinite(numericTaskId) && numericTaskId !== 0) {
    return runnableTasks.find((task) => Number(task.id) === numericTaskId) || null
  }
  if (Number.isFinite(numericTaskId) && numericTaskId === 0) {
    return runnableTasks.find((task) => !task.id) || (runnableTasks.length === 1 ? runnableTasks[0] : null)
  }
  return runnableTasks.length === 1 ? runnableTasks[0] : null
}

function buildManualBatchThinking(evaluation, providedScore) {
  const parts = []
  if (providedScore !== null && providedScore !== undefined) parts.push(`Manual batch provided score: ${providedScore}`)
  if (evaluation?.error) parts.push(`Evaluation note: ${evaluation.error}`)
  if (evaluation?.sandbox) parts.push(`## Sandbox evaluation\n\n\`\`\`json\n${JSON.stringify(evaluation.sandbox, null, 2)}\n\`\`\``)
  return parts.length > 0 ? parts.join('\n\n') : null
}

async function submitManualBatch(payload = {}) {
  const modelId = Number(payload.modelId)
  const benchmarkId = Number(payload.benchmarkId)
  const entries = Array.isArray(payload.entries) ? payload.entries : []
  const model = getModelById(modelId)
  const benchmark = getBenchmarkById(benchmarkId)

  if (!model) return { ok: false, error: 'Model was not found.', results: [] }
  if (!benchmark) return { ok: false, error: 'Benchmark was not found.', results: [] }
  if (entries.length === 0) return { ok: false, error: 'No responses in the manual batch.', results: [] }

  const runnableTasks = getRunnableTasks(benchmarkId, benchmark)
  const existingSession = payload.runSessionId || payload.sessionId ? getRunSession(payload.runSessionId || payload.sessionId) : null
  const session = existingSession || createRunSession({ model_id: modelId, benchmark_ids: [benchmarkId], current_benchmark_id: benchmarkId, completed_task_ids: [] })
  const repoSandboxRoots = getPreference('repo_sandbox_roots') || []
  const sandboxUseDocker = Boolean(getPreference('sandbox_use_docker'))
  const completedIdSet = new Set((session.completed_task_ids || []).map(Number))
  const batchResults = []

  updateRunSession(session.id, { current_benchmark_id: benchmarkId, status: 'running' })

  for (const entry of entries) {
    const task = resolveBatchTask(entry || {}, runnableTasks)
    const response = String(entry?.response ?? entry?.answer ?? entry?.patch ?? entry?.diff ?? '').trim()
    const taskId = task?.id || null

    if (!task) {
      batchResults.push({ ok: false, taskId: entry?.taskId ?? entry?.task_id ?? null, error: 'task_id was not found in this benchmark.' })
      continue
    }
    if (!response) {
      batchResults.push({ ok: false, taskId, error: 'Empty response in the manual batch.' })
      continue
    }

    try {
      updateRunSession(session.id, { current_benchmark_id: benchmarkId, current_task_id: taskId, status: 'running' })
      const evaluation = await evaluateScore(task, response, { repoSandboxRoots, useDocker: sandboxUseDocker })
      const providedScore = normalizeProvidedScore(entry?.score ?? entry?.result ?? entry?.passed, task.score_type)
      const scoreCandidate = providedScore !== null ? providedScore : (!evaluation?.needs_verify && evaluation?.score !== null && evaluation?.score !== undefined ? evaluation.score : null)

      if (scoreCandidate === null || scoreCandidate === undefined) {
        batchResults.push({
          ok: false,
          taskId,
          response,
          error: evaluation?.needs_verify
            ? 'This task requires separate manual verification.'
            : evaluation?.is_manual
              ? 'Could not evaluate automatically. Add score="0-100" or score="tak/nie" to the answer block.'
              : evaluation?.error || 'Could not evaluate the response from the manual batch.',
        })
        continue
      }

      const score = normalizeBenchmarkScore(task, scoreCandidate, 1, 1)
      const created = addResult({
        model_id: modelId,
        benchmark_id: benchmarkId,
        task_id: taskId,
        run_session_id: session.id,
        score,
        notes: response,
        thinking_notes: buildManualBatchThinking(evaluation, providedScore),
        attempt_number: 1,
        tokens_used: null,
        duration_ms: null,
      })

      if (taskId) completedIdSet.add(Number(taskId))
      updateRunSession(session.id, { completed_task_ids: Array.from(completedIdSet), current_task_id: taskId })
      batchResults.push({ ok: true, taskId, resultId: created.id, score: String(score), response, error: evaluation?.error || null })
    } catch (error) {
      batchResults.push({ ok: false, taskId, response, error: error instanceof Error ? error.message : 'Unknown manual batch evaluation error.' })
    }
  }

  const taskIds = runnableTasks.map((task) => task.id).filter(Boolean).map(Number)
  const allTasksCompleted = taskIds.length > 0 ? taskIds.every((taskId) => completedIdSet.has(taskId)) : batchResults.some((result) => result.ok)
  let aggregate = null

  if (payload.finish && allTasksCompleted && taskIds.length > 0) {
    const completedTaskResults = runnableTasks
      .map((task) => task.id ? getLatestTaskResult(modelId, benchmarkId, task.id, session.started_at) : null)
      .filter(Boolean)
      .map((saved) => ({
        benchmark_id: benchmarkId,
        task_id: saved.task_id,
        result_id: saved.id,
        score: saved.score,
        response: saved.notes,
        thinking: saved.thinking_notes,
        tokens_used: saved.tokens_used,
        duration_ms: saved.duration_ms,
        is_manual: false,
        error: null,
        attempt_number: saved.attempt_number || 1,
      }))
    const aggregateScore = aggregateBenchmarkScore(benchmark, completedTaskResults)
    if (aggregateScore !== null) {
      const aggregateResult = addResult({
        model_id: modelId,
        benchmark_id: benchmarkId,
        task_id: null,
        run_session_id: session.id,
        score: aggregateScore,
        notes: buildBenchmarkNotes(completedTaskResults, runnableTasks),
        thinking_notes: buildBenchmarkThinkingNotes(completedTaskResults, runnableTasks),
        attempt_number: 1,
        tokens_used: null,
        duration_ms: null,
      })
      aggregate = { resultId: aggregateResult.id, score: String(aggregateScore) }
    }
    finishRunSession(session.id)
  } else if (payload.finish && allTasksCompleted) {
    finishRunSession(session.id)
  }

  return {
    ok: batchResults.some((result) => result.ok),
    sessionId: session.id,
    completedTaskIds: Array.from(completedIdSet),
    results: batchResults,
    aggregate,
    error: batchResults.some((result) => !result.ok) ? 'Some manual batch responses were not saved.' : null,
  }
}

function streamProviderPrompt(provider, model, prompt, handlers, imageBase64 = null, signal = null) {
  return new Promise((resolve, reject) => {
    Promise.resolve(provider.streamPrompt(
      model,
      prompt,
      handlers.onChunk,
      (response, tokensUsed, usageDetails = null) => resolve({ response, tokens_used: tokensUsed, input_tokens: usageDetails?.input_tokens ?? null, output_tokens: usageDetails?.output_tokens ?? null }),
      (error) => reject(new Error(typeof error === 'string' ? error : error?.message || 'Unknown streaming error.')),
      imageBase64,
      signal,
      handlers.onThinkingChunk,
    )).catch(reject)
  })
}

async function runBenchmark(modelId, benchmarkId) {
  const model = getModelById(modelId)
  if (!model) return { results: [], summary: { total: 1, completed: 0, avgScore: null }, error: 'Model was not found.' }

  const benchmark = getBenchmarkById(benchmarkId)
  if (!benchmark) return { results: [], summary: { total: 1, completed: 0, avgScore: null }, error: 'Benchmark was not found.' }
  if (!benchmark.prompt_template?.trim()) return { results: [], summary: { total: 1, completed: 0, avgScore: null }, error: 'Benchmark has no prompt_template' }

  const provider = getProvider(model.mode)
  const repoSandboxRoots = getPreference('repo_sandbox_roots') || []
  const sandboxUseDocker = Boolean(getPreference('sandbox_use_docker'))
  const attempts = benchmark.attempts || 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const start = Date.now()
    const result = await provider.sendPrompt(model, benchmark.prompt_template, benchmark.output_type === 'maze' ? benchmark.reference_image : null)
    const durationMs = Date.now() - start
    if (result.response === '__MANUAL__') return { results: [{ benchmark_id: benchmarkId, score: null, response: null, is_manual: true, error: null, attempt_number: attempt }], summary: { total: 1, completed: 0, avgScore: null }, error: null }
    const evaluation = await evaluateScore(benchmark, result.response, { repoSandboxRoots, useDocker: sandboxUseDocker })
    if (evaluation.is_manual || evaluation.needs_verify) return { results: [{ benchmark_id: benchmarkId, score: null, response: result.response, tokens_used: result.tokens_used, input_tokens: result.input_tokens ?? null, output_tokens: result.output_tokens ?? null, duration_ms: durationMs, is_manual: true, needs_verify: evaluation.needs_verify, error: null, attempt_number: attempt }], summary: { total: 1, completed: 0, avgScore: null }, error: null }
    if (evaluation.error && attempt < attempts) continue
    const scoreValue = evaluation.score !== null && evaluation.score !== undefined ? evaluation.score : 0
    const score = normalizeBenchmarkScore(benchmark, scoreValue, attempt, attempts)
    const sandboxThinking = evaluation.sandbox ? `## Sandbox evaluation\n\n\`\`\`json\n${JSON.stringify(evaluation.sandbox, null, 2)}\n\`\`\`` : null
    const created = addResult({ model_id: modelId, benchmark_id: benchmarkId, score, notes: result.response, thinking_notes: sandboxThinking, attempt_number: attempt, tokens_used: result.tokens_used, input_tokens: result.input_tokens ?? null, output_tokens: result.output_tokens ?? null, duration_ms: durationMs })
    return { results: [{ benchmark_id: benchmarkId, result_id: created.id, score: String(score), response: result.response, tokens_used: result.tokens_used, input_tokens: result.input_tokens ?? null, output_tokens: result.output_tokens ?? null, estimated_cost_usd: created.estimated_cost_usd ?? null, duration_ms: durationMs, is_manual: false, error: null, attempt_number: attempt }], summary: { total: 1, completed: 1, avgScore: Number(score) || 0 }, error: null }
  }
}

async function runBenchmarkStreaming(modelId, benchmarkId, sendEvent, signal = null, sessionId = null, taskIds = null) {
  const model = getModelById(modelId)
  const benchmark = getBenchmarkById(benchmarkId)
  if (!model || !benchmark) {
    const error = !model ? 'Model was not found.' : 'Benchmark was not found.'
    sendEvent('benchmark:done', { summary: { total: 1, completed: 0, avgScore: null }, results: [], error })
    return { results: [], summary: { total: 1, completed: 0, avgScore: null }, error }
  }
  const requestedTaskIds = Array.isArray(taskIds) && taskIds.length > 0 ? new Set(taskIds.map(Number)) : null
  const runnableTasks = getRunnableTasks(benchmarkId, benchmark).filter((task) => !requestedTaskIds || requestedTaskIds.has(Number(task.id)))
  if (runnableTasks.some((task) => !task.prompt_template?.trim())) {
    const error = 'Benchmark has no prompt_template'
    sendEvent('task:error', { benchmarkId, error })
    sendEvent('benchmark:done', { summary: { total: 1, completed: 0, avgScore: null }, results: [], error })
    return { results: [], summary: { total: 1, completed: 0, avgScore: null }, error }
  }

  const existingSession = sessionId ? getRunSession(sessionId) : null
  const session = existingSession || createRunSession({ model_id: modelId, benchmark_ids: [benchmarkId], current_benchmark_id: benchmarkId, completed_task_ids: [] })

  try {
    if (signal?.aborted) throw new Error('Benchmark was cancelled by the user.')
    updateRunSession(session.id, { current_benchmark_id: benchmarkId, current_task_id: null, status: 'running' })
    const provider = getProvider(model.mode)
    const repoSandboxRoots = getPreference('repo_sandbox_roots') || []
    const sandboxUseDocker = Boolean(getPreference('sandbox_use_docker'))
    const sessionCompletedIds = Array.from(new Set((existingSession?.completed_task_ids || []).filter((taskId) => runnableTasks.some((task) => task.id === taskId))))
    const allResults = sessionCompletedIds
      .map((taskId) => {
        const saved = getLatestTaskResult(modelId, benchmarkId, taskId, session.started_at)
        return saved ? {
          benchmark_id: benchmarkId,
          task_id: taskId,
          result_id: saved.id,
          score: String(saved.score),
          response: saved.notes,
          thinking: saved.thinking_notes,
          tokens_used: saved.tokens_used,
          duration_ms: saved.duration_ms,
          is_manual: false,
          error: null,
          attempt_number: saved.attempt_number || 1,
          restored: true,
        } : null
      })
      .filter(Boolean)
    const completedIds = allResults.map((result) => result.task_id).filter(Boolean)
    const completedIdSet = new Set(completedIds)
    for (const task of runnableTasks) {
      if (task.id && completedIdSet.has(task.id)) continue
      updateRunSession(session.id, { current_benchmark_id: benchmarkId, current_task_id: task.id || null, status: 'running' })
      const attempts = task.attempts || 1
      let totalTaskDurationMs = 0
      let taskThinking = ''
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal?.aborted) throw new Error('Benchmark was cancelled by the user.')
        const start = Date.now()
        if (isToolTask(task, benchmark)) {
          const mcpServers = getPreference('mcp_servers') || []
          const agentResult = await runToolAgent({ provider, model, benchmark: { ...benchmark, id: benchmarkId }, task, sendEvent, signal, mcpServers })
          const durationMs = Date.now() - start
          totalTaskDurationMs += durationMs
          const agentScore = task.score_type === 'boolean' ? agentResult.score : agentResult.verification?.passed ? 100 : 0
          const createdTaskResult = addResult({
            model_id: modelId,
            benchmark_id: benchmarkId,
            task_id: task.id || null,
            run_session_id: session.id,
            score: agentScore,
            notes: agentResult.response,
            thinking_notes: agentResult.thinking,
            attempt_number: attempt,
            tokens_used: agentResult.tokens_used,
            duration_ms: totalTaskDurationMs,
          })
          const completed = { benchmark_id: benchmarkId, task_id: task.id, result_id: createdTaskResult.id, score: String(agentScore), response: agentResult.response, thinking: agentResult.thinking, tokens_used: agentResult.tokens_used, duration_ms: totalTaskDurationMs, is_manual: false, error: agentResult.verification?.passed ? null : agentResult.verification?.reason || null, attempt_number: attempt }
          allResults.push(completed)
          if (task.id && !completedIdSet.has(task.id)) {
            completedIds.push(task.id)
            completedIdSet.add(task.id)
          }
          updateRunSession(session.id, { completed_task_ids: completedIds, current_task_id: task.id || null })
          sendEvent('task:done', { benchmarkId, taskId: task.id, sessionId: session.id, score: String(agentScore), response: agentResult.response, thinking: agentResult.thinking, attemptNumber: attempt, is_manual: false, resultId: createdTaskResult.id, tokensUsed: agentResult.tokens_used, durationMs, totalDurationMs: totalTaskDurationMs, error: completed.error, toolWorkdir: agentResult.workdir, toolVerification: agentResult.verification })
          break
        }
        const result = await streamProviderPrompt(provider, model, task.prompt_template, {
          onChunk: (text) => sendEvent('task:chunk', { benchmarkId, taskId: task.id, text, attemptNumber: attempt }),
          onThinkingChunk: (text) => {
            taskThinking += text
            sendEvent('task:thinking-chunk', { benchmarkId, taskId: task.id, text, attemptNumber: attempt })
          },
        }, task.output_type === 'maze' ? task.reference_image : null, signal)
        const durationMs = Date.now() - start
        totalTaskDurationMs += durationMs
        if (result.response === '__MANUAL__') {
          const manual = { benchmark_id: benchmarkId, task_id: task.id, score: null, response: null, thinking: taskThinking, tokens_used: result.tokens_used, duration_ms: durationMs, is_manual: true, error: null, attempt_number: attempt }
          sendEvent('task:done', { benchmarkId, taskId: task.id, sessionId: session.id, score: null, response: null, attemptNumber: attempt, is_manual: true, tokensUsed: result.tokens_used, durationMs, totalDurationMs: totalTaskDurationMs })
          allResults.push(manual)
          break
        }

        const evaluation = await evaluateScore(task, result.response, { repoSandboxRoots, useDocker: sandboxUseDocker })
        if (evaluation.needs_verify) {
          const verify = { benchmark_id: benchmarkId, task_id: task.id, score: null, response: result.response, thinking: taskThinking, tokens_used: result.tokens_used, duration_ms: durationMs, is_manual: false, needs_verify: true, error: null, attempt_number: attempt }
          sendEvent('task:needs-maze-verify', { benchmarkId, taskId: task.id, sessionId: session.id, modelId, modelResponse: result.response, referenceImage: task.reference_image, passCondition: task.pass_condition, attemptNumber: attempt, tokensUsed: result.tokens_used, durationMs, totalDurationMs: totalTaskDurationMs })
          allResults.push(verify)
          break
        }
        if (evaluation.is_manual) {
          const manual = { benchmark_id: benchmarkId, task_id: task.id, score: null, response: result.response, thinking: taskThinking, tokens_used: result.tokens_used, duration_ms: durationMs, is_manual: true, error: null, attempt_number: attempt }
          sendEvent('task:done', { benchmarkId, taskId: task.id, sessionId: session.id, score: null, response: result.response, attemptNumber: attempt, is_manual: true, output_type: task.output_type, tokensUsed: result.tokens_used, durationMs, totalDurationMs: totalTaskDurationMs })
          allResults.push(manual)
          break
        }
        if (evaluation.error && attempt < attempts) {
          sendEvent('task:retry', { benchmarkId, taskId: task.id, attempt: attempt + 1, maxAttempts: attempts, durationMs, totalDurationMs: totalTaskDurationMs })
          continue
        }

        const scoreValue = evaluation.score !== null && evaluation.score !== undefined ? evaluation.score : 0
        const score = normalizeBenchmarkScore(task, scoreValue, attempt, attempts)
        const sandboxThinking = evaluation.sandbox ? `${taskThinking || ''}\n\n## Sandbox evaluation\n\n\`\`\`json\n${JSON.stringify(evaluation.sandbox, null, 2)}\n\`\`\`` : taskThinking
        const createdTaskResult = addResult({ model_id: modelId, benchmark_id: benchmarkId, task_id: task.id || null, run_session_id: session.id, score, notes: result.response, thinking_notes: sandboxThinking, attempt_number: attempt, tokens_used: result.tokens_used, input_tokens: result.input_tokens ?? null, output_tokens: result.output_tokens ?? null, duration_ms: totalTaskDurationMs })
        const completed = { benchmark_id: benchmarkId, task_id: task.id, result_id: createdTaskResult.id, score: String(score), response: result.response, thinking: sandboxThinking, tokens_used: result.tokens_used, input_tokens: result.input_tokens ?? null, output_tokens: result.output_tokens ?? null, estimated_cost_usd: createdTaskResult.estimated_cost_usd ?? null, duration_ms: totalTaskDurationMs, is_manual: false, error: evaluation.error || null, attempt_number: attempt }
        allResults.push(completed)
        if (task.id && !completedIdSet.has(task.id)) {
          completedIds.push(task.id)
          completedIdSet.add(task.id)
        }
        updateRunSession(session.id, { completed_task_ids: completedIds, current_task_id: task.id || null })
        sendEvent('task:done', { benchmarkId, taskId: task.id, sessionId: session.id, score: String(score), response: result.response, thinking: sandboxThinking || null, attemptNumber: attempt, is_manual: false, resultId: createdTaskResult.id, tokensUsed: result.tokens_used, durationMs, totalDurationMs: totalTaskDurationMs, error: evaluation.error || null, sandbox: evaluation.sandbox || null })
        break
      }
    }
    const completedTaskResults = allResults.filter((item) => !item.is_manual && !item.needs_verify && item.score !== null && item.score !== undefined)
    const aggregateScore = aggregateBenchmarkScore(benchmark, completedTaskResults)
    let aggregateResult = null
    if (aggregateScore !== null) {
      const totalTokens = completedTaskResults.reduce((sum, item) => sum + (Number(item.tokens_used) || 0), 0)
      const totalInputTokens = completedTaskResults.reduce((sum, item) => sum + (Number(item.input_tokens) || 0), 0)
      const totalOutputTokens = completedTaskResults.reduce((sum, item) => sum + (Number(item.output_tokens) || 0), 0)
      const totalDuration = completedTaskResults.reduce((sum, item) => sum + (Number(item.duration_ms) || 0), 0)
        aggregateResult = addResult({
        model_id: modelId,
        benchmark_id: benchmarkId,
        task_id: null,
          run_session_id: session.id,
          score: aggregateScore,
          notes: buildBenchmarkNotes(completedTaskResults, runnableTasks),
          thinking_notes: buildBenchmarkThinkingNotes(completedTaskResults, runnableTasks),
          attempt_number: 1,
        tokens_used: totalTokens || null,
        input_tokens: totalInputTokens || null,
        output_tokens: totalOutputTokens || null,
        duration_ms: totalDuration || null,
      })
    }
    const doneScores = completedTaskResults.map((item) => Number(item.score)).filter((value) => !Number.isNaN(value))
    const avgScore = aggregateScore === null ? null : benchmark.score_type === 'boolean' ? (aggregateScore === 'tak' ? 1 : 0) : Number(aggregateScore)
    finishRunSession(session.id)
    const summary = { total: runnableTasks.length, completed: completedTaskResults.length, avgScore }
    if (aggregateResult) {
      allResults.push({ benchmark_id: benchmarkId, task_id: null, result_id: aggregateResult.id, score: String(aggregateScore), response: aggregateResult.notes, thinking: aggregateResult.thinking_notes, tokens_used: aggregateResult.tokens_used, input_tokens: aggregateResult.input_tokens ?? null, output_tokens: aggregateResult.output_tokens ?? null, estimated_cost_usd: aggregateResult.estimated_cost_usd ?? null, duration_ms: aggregateResult.duration_ms, is_manual: false, error: null, attempt_number: 1, aggregate: true })
    }
    sendEvent('benchmark:done', { summary, results: allResults, error: null })
    return { results: allResults, summary, error: null }
  } catch (error) {
    const message = signal?.aborted ? 'Benchmark was cancelled by the user.' : error instanceof Error ? error.message : 'Unknown benchmark error.'
    if (signal?.aborted) {
      cancelRunSession(session.id)
      sendEvent('benchmark:aborted', {})
    } else {
      sendEvent('task:error', { benchmarkId, error: message })
      sendEvent('benchmark:done', { summary: { total: 1, completed: 0, avgScore: null }, results: [], error: message })
    }
    return { results: [], summary: { total: 1, completed: 0, avgScore: null }, error: message }
  }

  const error = 'Could not start the benchmark.'
  sendEvent('task:error', { benchmarkId, error })
  return { results: [], summary: { total: 1, completed: 0, avgScore: null }, error }
}

module.exports = { runBenchmark, runBenchmarkStreaming, submitManualBatch }
