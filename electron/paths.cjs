const fs = require('fs')
const path = require('path')
const { app } = require('electron')

function getAppBasePath() {
  if (process.env.BENCHFORGE_APP_DIR) return path.resolve(process.env.BENCHFORGE_APP_DIR)
  if (app.isPackaged) return path.dirname(process.execPath)
  return path.resolve(__dirname, '..')
}

function getDataPath() {
  const dataPath = process.env.BENCHFORGE_DATA_DIR
    ? path.resolve(process.env.BENCHFORGE_DATA_DIR)
    : path.join(getAppBasePath(), 'data')
  fs.mkdirSync(dataPath, { recursive: true })
  return dataPath
}

function resolveDataPath(relativePath = '') {
  const dataRoot = path.resolve(getDataPath())
  const absolute = path.resolve(dataRoot, String(relativePath || ''))
  const relative = path.relative(dataRoot, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}

module.exports = {
  getAppBasePath,
  getDataPath,
  resolveDataPath,
}
