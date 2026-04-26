async function sendPrompt() {
  return {
    response: '__MANUAL__',
    tokens_used: null,
  }
}

async function streamPrompt(_modelConfig, _prompt, _onChunk, onDone) {
  onDone('__MANUAL__', null)
}

async function testConnection() {
  return {
    ok: true,
    error: null,
  }
}

module.exports = {
  sendPrompt,
  streamPrompt,
  testConnection,
}
