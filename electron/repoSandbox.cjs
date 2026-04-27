const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { resolveDataPath } = require('./paths.cjs')

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 120_000

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/')
}

function safeName(value) {
  return String(value || 'repo').replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'repo'
}

function createWorkdir(spec) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = `${safeName(spec.repo || spec.instance_id || 'repo')}-${stamp}-${Math.random().toString(36).slice(2, 8)}`
  const relativePath = toPosix(path.join('artifacts', 'repo-sandbox', id))
  const absolutePath = resolveDataPath(relativePath)
  fs.mkdirSync(absolutePath, { recursive: true })
  return { relativePath, absolutePath }
}

function trimOutput(value) {
  const text = String(value || '')
  if (Buffer.byteLength(text, 'utf-8') <= MAX_OUTPUT_BYTES) return text
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n...[truncated]`
}

function runProcess(command, args, options = {}) {
  const timeoutMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)))
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args || [], {
      cwd: options.cwd,
      shell: Boolean(options.shell),
      windowsHide: true,
      env: {
        ...process.env,
        ...(options.env || {}),
        BENCHFORGE_REPO_SANDBOX: '1',
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

function parseCondition(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function getRepoSpec(benchmark) {
  const parsed = parseCondition(benchmark?.pass_condition)
  const mode = String(parsed?.mode || '')
  if (!['swe_bench_patch', 'repo_patch'].includes(mode)) return null
  return {
    mode,
    repo: parsed.repo || parsed.repository || null,
    instance_id: parsed.instance_id || parsed.instanceId || null,
    base_commit: parsed.base_commit || parsed.baseCommit || null,
    test_patch: parsed.test_patch || parsed.testPatch || null,
    reference_patch: parsed.patch || null,
    test_command: parsed.test_command || parsed.testCommand || null,
    timeoutMs: Math.max(1000, Math.min(30 * 60 * 1000, Number(parsed.timeout_ms || parsed.timeoutMs || DEFAULT_TIMEOUT_MS))),
    raw: parsed,
  }
}

function findRepoConfig(spec, roots = []) {
  const configs = Array.isArray(roots) ? roots : []
  return configs.find((item) => {
    if (!item || typeof item !== 'object') return false
    if (item.instanceId || item.instance_id) return String(item.instanceId || item.instance_id) === String(spec.instance_id || '')
    return String(item.repo || item.repository || '') === String(spec.repo || '')
  }) || null
}

function extractPatch(response) {
  const text = String(response || '')
  const fenced = text.match(/```(?:diff|patch)?\s*([\s\S]*?)```/i)
  const fencedText = fenced?.[1]?.trim()
  if (fencedText && (fencedText.includes('diff --git') || (fencedText.includes('--- ') && fencedText.includes('+++ ')))) return fencedText
  const diffIndex = text.indexOf('diff --git ')
  if (diffIndex >= 0) return text.slice(diffIndex).trim()
  const unifiedIndex = text.search(/^---\s+/m)
  if (unifiedIndex >= 0 && text.slice(unifiedIndex).includes('+++ ')) return text.slice(unifiedIndex).trim()
  return ''
}

function copyRecursive(source, target) {
  const skip = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'dist', 'build', '.next'])
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const src = path.join(source, entry.name)
    const dst = path.join(target, entry.name)
    if (entry.isDirectory()) copyRecursive(src, dst)
    else if (entry.isSymbolicLink()) {
      try { fs.symlinkSync(fs.readlinkSync(src), dst) } catch {}
    } else fs.copyFileSync(src, dst)
  }
}

async function prepareRepo(sourcePath, targetPath, spec, timeoutMs) {
  const commands = []
  const clone = await runProcess('git', ['clone', '--no-hardlinks', sourcePath, targetPath], { timeoutMs })
  commands.push({ command: `git clone --no-hardlinks ${sourcePath}`, ...clone })
  if (!clone.ok) {
    try {
      copyRecursive(sourcePath, targetPath)
      commands.push({ command: 'fs.copyRecursive fallback', ok: true, stdout: '', stderr: '' })
    } catch (error) {
      commands.push({ command: 'fs.copyRecursive fallback', ok: false, stderr: error instanceof Error ? error.message : String(error) })
      return { ok: false, commands }
    }
  }
  if (spec.base_commit && fs.existsSync(path.join(targetPath, '.git'))) {
    const checkout = await runProcess('git', ['checkout', '--force', spec.base_commit], { cwd: targetPath, timeoutMs })
    commands.push({ command: `git checkout --force ${spec.base_commit}`, ...checkout })
    const clean = await runProcess('git', ['clean', '-fdx'], { cwd: targetPath, timeoutMs })
    commands.push({ command: 'git clean -fdx', ...clean })
  }
  return { ok: true, commands }
}

async function applyPatch(repoDir, patchPath, label, timeoutMs) {
  const first = await runProcess('git', ['apply', '--whitespace=nowarn', patchPath], { cwd: repoDir, timeoutMs })
  if (first.ok) return { command: `git apply ${label}`, ...first }
  const second = await runProcess('git', ['apply', '--reject', '--whitespace=nowarn', patchPath], { cwd: repoDir, timeoutMs })
  return { command: `git apply --reject ${label}`, ok: second.ok, exitCode: second.exitCode, timedOut: second.timedOut, stdout: `${first.stdout}\n${second.stdout}`.trim(), stderr: `${first.stderr}\n${second.stderr}`.trim(), durationMs: first.durationMs + second.durationMs }
}

function detectTestCommand(repoDir, config, spec) {
  if (config?.testCommand || config?.test_command) return String(config.testCommand || config.test_command)
  if (spec.test_command) return String(spec.test_command)
  if (fs.existsSync(path.join(repoDir, 'pytest.ini')) || fs.existsSync(path.join(repoDir, 'pyproject.toml')) || fs.existsSync(path.join(repoDir, 'setup.cfg'))) return 'python -m pytest'
  if (fs.existsSync(path.join(repoDir, 'package.json'))) return 'npm test'
  return null
}

async function evaluateRepoSandbox(benchmark, response, roots = []) {
  const spec = getRepoSpec(benchmark)
  if (!spec) return null
  const config = findRepoConfig(spec, roots)
  if (!config?.path) return null
  const sourcePath = path.resolve(String(config.path))
  if (!fs.existsSync(sourcePath)) return { score: 0, error: `Repo sandbox: path does not exist: ${sourcePath}`, passed: 0, total: 2, allow_partial: true, sandbox: { version: 3, type: 'repo_patch', ok: false, score: 0, spec, error: 'missing repo path' } }
  const candidatePatch = extractPatch(response)
  if (!candidatePatch) return { score: 0, error: 'Repo sandbox: no patch/diff found in model response.', passed: 0, total: 2, allow_partial: true, sandbox: { version: 3, type: 'repo_patch', ok: false, score: 0, spec, error: 'no patch found' } }

  const timeoutMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(config.timeoutMs || config.timeout_ms || spec.timeoutMs || DEFAULT_TIMEOUT_MS)))
  const workdir = createWorkdir(spec)
  const repoDir = path.join(workdir.absolutePath, 'repo')
  const commands = []
  fs.writeFileSync(path.join(workdir.absolutePath, 'candidate.patch'), candidatePatch, 'utf-8')
  if (spec.test_patch) fs.writeFileSync(path.join(workdir.absolutePath, 'test.patch'), String(spec.test_patch), 'utf-8')

  const prepared = await prepareRepo(sourcePath, repoDir, spec, timeoutMs)
  commands.push(...prepared.commands)
  if (!prepared.ok) {
    const sandbox = { version: 3, type: 'repo_patch', ok: false, score: 0, spec, workdir: workdir.relativePath, repoDir: toPosix(path.join(workdir.relativePath, 'repo')), commands }
    fs.writeFileSync(path.join(workdir.absolutePath, 'repo-sandbox-report.json'), JSON.stringify(sandbox, null, 2), 'utf-8')
    return { score: 0, error: 'Repo sandbox: failed to prepare repository.', passed: 0, total: 2, allow_partial: true, sandbox }
  }

  const patchResult = await applyPatch(repoDir, path.join(workdir.absolutePath, 'candidate.patch'), 'candidate.patch', timeoutMs)
  commands.push(patchResult)
  if (spec.test_patch) commands.push(await applyPatch(repoDir, path.join(workdir.absolutePath, 'test.patch'), 'test.patch', timeoutMs))

  const testCommand = detectTestCommand(repoDir, config, spec)
  let testResult = null
  if (patchResult.ok && testCommand) {
    testResult = await runProcess(testCommand, [], { cwd: repoDir, timeoutMs, shell: true })
    commands.push({ command: testCommand, ...testResult })
  }

  const patchScore = patchResult.ok ? 50 : 0
  const testScore = testCommand ? testResult?.ok ? 50 : 0 : patchResult.ok ? 0 : 0
  const score = patchScore + testScore
  const total = testCommand ? 2 : 1
  const passed = (patchResult.ok ? 1 : 0) + (testCommand && testResult?.ok ? 1 : 0)
  const ok = patchResult.ok && (testCommand ? Boolean(testResult?.ok) : true)
  const sandbox = {
    version: 3,
    type: 'repo_patch',
    ok,
    score: testCommand ? score : patchResult.ok ? 50 : 0,
    passed,
    total,
    spec,
    config: { repo: config.repo || config.repository || spec.repo, path: sourcePath, testCommand: testCommand || null },
    workdir: workdir.relativePath,
    repoDir: toPosix(path.join(workdir.relativePath, 'repo')),
    patchApplied: patchResult.ok,
    testsRun: Boolean(testCommand),
    testsPassed: Boolean(testResult?.ok),
    commands,
    tests: [
      { index: 1, test: 'git apply candidate.patch', passed: patchResult.ok, error: patchResult.ok ? null : patchResult.stderr || patchResult.stdout || 'patch failed' },
      ...(testCommand ? [{ index: 2, test: testCommand, passed: Boolean(testResult?.ok), error: testResult?.ok ? null : testResult?.stderr || testResult?.stdout || 'tests failed' }] : []),
    ],
    stdout: commands.map((item) => `# ${item.command}\n${item.stdout || ''}`).join('\n\n'),
    stderr: commands.map((item) => `# ${item.command}\n${item.stderr || ''}`).join('\n\n'),
  }
  fs.writeFileSync(path.join(workdir.absolutePath, 'repo-sandbox-report.json'), JSON.stringify(sandbox, null, 2), 'utf-8')
  const error = ok ? null : `Repo sandbox failed: patch=${patchResult.ok ? 'ok' : 'fail'}${testCommand ? ` tests=${testResult?.ok ? 'ok' : 'fail'}` : ' tests=not configured'}`
  return { score: sandbox.score, error, passed, total, allow_partial: true, sandbox }
}

module.exports = { evaluateRepoSandbox, extractPatch, getRepoSpec }
