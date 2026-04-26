const { spawn } = require('child_process')

function runVersion(command, args = [], timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      resolve({ ok: false, command: [command, ...args].join(' '), error: 'timeout', stdout, stderr })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, command: [command, ...args].join(' '), error: error.message, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const output = `${stdout}\n${stderr}`.trim()
      resolve({ ok: code === 0, command: [command, ...args].join(' '), version: output.split(/\r?\n/)[0] || null, stdout, stderr, exitCode: code })
    })
  })
}

async function firstOk(label, candidates, required = false) {
  const attempts = []
  for (const candidate of candidates) {
    const result = await runVersion(candidate.command, candidate.args || [])
    attempts.push(result)
    if (result.ok) return { label, ok: true, required, command: result.command, version: result.version, attempts }
  }
  return { label, ok: false, required, command: candidates.map((item) => [item.command, ...(item.args || [])].join(' ')).join(' | '), error: attempts.map((item) => item.error || item.stderr).filter(Boolean).join(' ; ') || 'not found', attempts }
}

async function checkEnvironment() {
  const checks = []
  checks.push(await firstOk('Node', [{ command: process.execPath, args: ['--version'] }, { command: 'node', args: ['--version'] }], true))
  checks.push(await firstOk('npm', [{ command: 'npm', args: ['--version'] }], false))
  checks.push(await firstOk('Python', [{ command: 'python', args: ['--version'] }, { command: 'py', args: ['-3', '--version'] }, { command: 'python3', args: ['--version'] }], true))
  checks.push(await firstOk('pytest', [{ command: 'python', args: ['-m', 'pytest', '--version'] }, { command: 'py', args: ['-3', '-m', 'pytest', '--version'] }, { command: 'python3', args: ['-m', 'pytest', '--version'] }], false))
  checks.push(await firstOk('Git', [{ command: 'git', args: ['--version'] }], true))
  checks.push(await firstOk('Docker', [{ command: 'docker', args: ['--version'] }], false))
  checks.push(await firstOk('npx', [{ command: 'npx', args: ['--version'] }], false))
  return { ok: checks.filter((check) => check.required).every((check) => check.ok), checks }
}

module.exports = { checkEnvironment, runVersion }
