const apiProvider = require('./api.cjs')
const manualProvider = require('./manual.cjs')

function getProvider(mode) {
  if (mode === 'manual') {
    return manualProvider
  }

  if (mode === 'api') {
    return apiProvider
  }

  throw new Error(`Nieobsługiwany tryb modelu: ${mode}`)
}

module.exports = {
  getProvider,
}
