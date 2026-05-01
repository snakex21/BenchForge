// Każdy provider musi implementować:
// sendPrompt(modelConfig, prompt) => Promise<{ response: string, tokens_used: number | null, input_tokens?: number | null, output_tokens?: number | null }>
// testConnection(modelConfig) => Promise<{ ok: boolean, error: string | null }>

module.exports = {}
