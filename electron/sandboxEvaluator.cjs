const { runTool } = require('./toolRuntime.cjs')
const { evaluateRepoSandbox } = require('./repoSandbox.cjs')

const REPORT_MARKER = 'BENCHFORGE_SANDBOX_REPORT '

function parseCondition(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function getSandboxSpec(benchmark) {
  const parsed = parseCondition(benchmark?.pass_condition)
  const sandbox = parsed?.sandbox && typeof parsed.sandbox === 'object' ? parsed.sandbox : null
  if (!sandbox) return null
  const tests = Array.isArray(sandbox.tests) ? sandbox.tests.map(String).filter(Boolean) : []
  if (tests.length === 0) return null
  return {
    mode: parsed.mode || null,
    required: Array.isArray(parsed.required) ? parsed.required.map(String).filter(Boolean) : [],
    language: String(sandbox.language || 'python').toLowerCase(),
    source: sandbox.source || null,
    task_id: sandbox.task_id || null,
    entry_point: sandbox.entry_point || null,
    tests,
    test_setup_code: sandbox.test_setup_code || null,
    timeoutMs: Math.max(1000, Math.min(120000, Number(sandbox.timeout_ms || sandbox.timeoutMs || 10000))),
  }
}

function extractCode(response, language = '') {
  const text = String(response || '').trim()
  if (!text) return ''
  const lang = language.toLowerCase()
  const langPattern = lang.includes('python')
    ? 'python|py'
    : lang.includes('typescript') || lang === 'ts'
      ? 'typescript|ts'
      : lang.includes('javascript') || lang === 'js' || lang === 'node'
        ? 'javascript|js|node'
        : '[a-zA-Z0-9_+-]+'
  const preferred = new RegExp('```(?:' + langPattern + ')\\s*([\\s\\S]*?)```', 'i')
  const preferredMatch = text.match(preferred)
  if (preferredMatch?.[1]) return preferredMatch[1].trim()
  const anyMatch = text.match(/```[a-zA-Z0-9_+-]*\s*([\s\S]*?)```/)
  if (anyMatch?.[1]) return anyMatch[1].trim()
  return text
}

function stripTypeScript(code) {
  return String(code || '')
    .replace(/^\s*import\s+type\s+[^;]+;?\s*$/gm, '')
    .replace(/^\s*type\s+\w+[\s\S]*?;\s*$/gm, '')
    .replace(/^\s*interface\s+\w+\s*{[\s\S]*?}\s*$/gm, '')
    .replace(/export\s+(?=(function|const|let|var|class)\b)/g, '')
    .replace(/:\s*[A-Za-z_$][\w$<>,\[\]\s|&?:.]*(?=\s*[,)=;{])/g, '')
    .replace(/\b(public|private|protected|readonly)\s+/g, '')
}

function buildPythonHarness(code, spec) {
  return `
import json
import traceback

${code}

${spec.test_setup_code || ''}

__benchforge_tests = ${JSON.stringify(spec.tests)}
__benchforge_entry_point = ${JSON.stringify(spec.entry_point || '')}
__benchforge_report = {"tests": [], "passed": 0, "total": len(__benchforge_tests)}

for __benchforge_index, __benchforge_test in enumerate(__benchforge_tests, start=1):
    __benchforge_item = {"index": __benchforge_index, "test": __benchforge_test, "passed": False, "error": None}
    try:
        exec(__benchforge_test, globals())
        if 'check' in globals() and callable(globals()['check']) and __benchforge_entry_point and __benchforge_entry_point in globals():
            globals()['check'](globals()[__benchforge_entry_point])
        __benchforge_item["passed"] = True
        __benchforge_report["passed"] += 1
    except Exception:
        __benchforge_item["error"] = traceback.format_exc(limit=4)
    __benchforge_report["tests"].append(__benchforge_item)

__benchforge_report["ok"] = __benchforge_report["passed"] == __benchforge_report["total"]
print(${JSON.stringify(REPORT_MARKER)} + json.dumps(__benchforge_report, ensure_ascii=False))
if not __benchforge_report["ok"]:
    raise SystemExit(1)
`.trimStart()
}

function buildNodeHarness(code, spec) {
  return `
const assert = (condition, message = 'assertion failed') => { if (!condition) throw new Error(message) }
global.assert = assert

${code}

const __benchforgeTests = ${JSON.stringify(spec.tests)}
const __benchforgeReport = { tests: [], passed: 0, total: __benchforgeTests.length }
for (let i = 0; i < __benchforgeTests.length; i++) {
  const test = __benchforgeTests[i]
  const item = { index: i + 1, test, passed: false, error: null }
  try {
    const result = eval(test)
    if (typeof result === 'boolean') assert(result, 'test #' + (i + 1) + ' returned false: ' + test)
    item.passed = true
    __benchforgeReport.passed += 1
  } catch (error) {
    item.error = error && error.stack ? error.stack : String(error)
  }
  __benchforgeReport.tests.push(item)
}
__benchforgeReport.ok = __benchforgeReport.passed === __benchforgeReport.total
console.log(${JSON.stringify(REPORT_MARKER)} + JSON.stringify(__benchforgeReport))
if (!__benchforgeReport.ok) process.exit(1)
`.trimStart()
}

function parseReport(stdout, totalFallback = 1) {
  const lines = String(stdout || '').split(/\r?\n/g)
  const line = [...lines].reverse().find((entry) => entry.startsWith(REPORT_MARKER))
  if (!line) return null
  try {
    const parsed = JSON.parse(line.slice(REPORT_MARKER.length))
    const total = Math.max(1, Number(parsed.total || totalFallback))
    const passed = Math.max(0, Math.min(total, Number(parsed.passed || 0)))
    return { ...parsed, total, passed, ok: passed === total }
  } catch {
    return null
  }
}

async function writeSandboxReport(workdir, report) {
  if (!workdir) return
  await runTool({ tool: 'file.write', workdir, input: { path: 'sandbox-report.json', content: JSON.stringify(report, null, 2) } })
}

function buildEvaluation({ spec, result, language, report }) {
  const total = report?.total || spec.tests.length || 1
  const passed = report?.passed || 0
  const score = Math.round((passed / Math.max(1, total)) * 100)
  const ok = passed === total && Boolean(result.ok)
  const sandbox = {
    version: 2,
    spec,
    ok,
    language,
    score,
    passed,
    total,
    tests: report?.tests || [],
    workdir: result.workdir,
    tracePath: result.tracePath,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timedOut: Boolean(result.timedOut),
    exitCode: result.exitCode ?? null,
  }
  return {
    score,
    error: ok ? null : `Sandbox ${language} failed: ${passed}/${total} tests passed. ${String(result.stderr || result.error || '').slice(0, 800)}`,
    passed,
    total,
    allow_partial: true,
    sandbox,
  }
}

async function evaluateSandbox(benchmark, response, options = {}) {
  const repoSandbox = await evaluateRepoSandbox(benchmark, response, options.repoSandboxRoots || [])
  if (repoSandbox) return repoSandbox

  const spec = getSandboxSpec(benchmark)
  if (!spec) return null

  const language = spec.language
  let code = extractCode(response, language)
  if (!code.trim()) {
    return { score: 0, error: 'Sandbox: no code found in model response.', passed: 0, total: 1, allow_partial: true, sandbox: { version: 2, spec, ok: false, score: 0, passed: 0, total: 1, tests: [] } }
  }

  if (language === 'python' || language === 'py') {
    const result = await runTool({ tool: 'python.run', input: { code: buildPythonHarness(code, spec), timeoutMs: spec.timeoutMs, useDocker: Boolean(options.useDocker) } })
    const report = parseReport(result.stdout, spec.tests.length) || { passed: result.ok ? spec.tests.length : 0, total: spec.tests.length, tests: [] }
    const evaluation = buildEvaluation({ spec, result, language: 'python', report })
    await writeSandboxReport(result.workdir, evaluation.sandbox)
    return evaluation
  }

  if (language === 'typescript' || language === 'ts') {
    code = stripTypeScript(code)
  }

  if (['javascript', 'js', 'node', 'typescript', 'ts'].includes(language)) {
    const result = await runTool({ tool: 'node.run', input: { code: buildNodeHarness(code, spec), timeoutMs: spec.timeoutMs, useDocker: Boolean(options.useDocker) } })
    const report = parseReport(result.stdout, spec.tests.length) || { passed: result.ok ? spec.tests.length : 0, total: spec.tests.length, tests: [] }
    const evaluation = buildEvaluation({ spec, result, language: language === 'typescript' || language === 'ts' ? 'typescript-lite' : 'node', report })
    await writeSandboxReport(result.workdir, evaluation.sandbox)
    return evaluation
  }

  return null
}

module.exports = { evaluateSandbox, extractCode, getSandboxSpec, stripTypeScript }
