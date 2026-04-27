const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const targetDir = path.resolve(process.argv[2] || 'release')
const outputName = 'SHA256SUMS.txt'

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

if (!fs.existsSync(targetDir)) {
  console.error(`[checksums] Directory does not exist: ${targetDir}`)
  process.exit(1)
}

const files = fs.readdirSync(targetDir)
  .filter((name) => name !== outputName)
  .filter((name) => fs.statSync(path.join(targetDir, name)).isFile())
  .sort((a, b) => a.localeCompare(b))

const lines = files.map((name) => `${sha256(path.join(targetDir, name))}  ${name}`)
fs.writeFileSync(path.join(targetDir, outputName), `${lines.join('\n')}\n`, 'utf8')
console.log(`[checksums] Wrote ${outputName} for ${files.length} file(s).`)
