const fs = require('fs')
const path = require('path')

const localesDir = path.join(__dirname, '..', 'frontend', 'src', 'i18n', 'locales')
const sourceLocale = 'en.json'

function readJson(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(content)
}

function placeholders(value) {
  return new Set(String(value || '').match(/\{[a-zA-Z0-9_]+\}/g) || [])
}

function diffSet(a, b) {
  return Array.from(a).filter((item) => !b.has(item))
}

const files = fs.readdirSync(localesDir).filter((file) => file.endsWith('.json')).sort()
const source = readJson(path.join(localesDir, sourceLocale))
const sourceKeys = Object.keys(source)
const sourceKeySet = new Set(sourceKeys)

let totalMissing = 0
let totalExtra = 0
let totalPlaceholderIssues = 0
let hasErrors = false

console.log(`i18n check: ${files.length} locale files, ${sourceKeys.length} source keys (${sourceLocale})`)
console.log('')

for (const file of files) {
  const filePath = path.join(localesDir, file)
  let data
  try {
    data = readJson(filePath)
  } catch (error) {
    hasErrors = true
    console.error(`${file}: invalid JSON - ${error.message}`)
    continue
  }

  const keys = Object.keys(data)
  const keySet = new Set(keys)
  const missing = sourceKeys.filter((key) => !keySet.has(key))
  const extra = keys.filter((key) => !sourceKeySet.has(key))
  const placeholderIssues = []

  for (const key of keys) {
    if (!sourceKeySet.has(key)) continue
    const expected = placeholders(source[key])
    const actual = placeholders(data[key])
    const missingPlaceholders = diffSet(expected, actual)
    const extraPlaceholders = diffSet(actual, expected)
    if (missingPlaceholders.length || extraPlaceholders.length) {
      placeholderIssues.push({ key, missing: missingPlaceholders, extra: extraPlaceholders })
    }
  }

  totalMissing += missing.length
  totalExtra += extra.length
  totalPlaceholderIssues += placeholderIssues.length

  const status = missing.length || extra.length || placeholderIssues.length ? 'WARN' : 'OK'
  console.log(`${status.padEnd(4)} ${file.padEnd(10)} keys=${String(keys.length).padEnd(4)} missing=${String(missing.length).padEnd(4)} extra=${String(extra.length).padEnd(3)} placeholders=${placeholderIssues.length}`)

  if (missing.length) console.log(`     missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' ...' : ''}`)
  if (extra.length) console.log(`     extra: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' ...' : ''}`)
  if (placeholderIssues.length) {
    for (const issue of placeholderIssues.slice(0, 5)) {
      console.log(`     placeholder ${issue.key}: missing=[${issue.missing.join(', ')}] extra=[${issue.extra.join(', ')}]`)
    }
    if (placeholderIssues.length > 5) console.log(`     ... ${placeholderIssues.length - 5} more placeholder issues`)
  }
}

console.log('')
console.log(`Summary: missing=${totalMissing}, extra=${totalExtra}, placeholderIssues=${totalPlaceholderIssues}`)

if (totalExtra || totalPlaceholderIssues) hasErrors = true
process.exit(hasErrors ? 1 : 0)
