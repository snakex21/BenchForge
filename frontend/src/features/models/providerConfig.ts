import type { ApiProvider } from '@/types'

export interface ProviderOption {
  value: ApiProvider
  label: string
  baseUrl: string
  modelPlaceholder: string
  apiKeyPlaceholder: string
}

export interface ProviderGroup {
  label: string
  options: ProviderOption[]
}

export interface ProviderScanOverride {
  url?: string
  scanPath?: string
  authType?: string
  scanUnsupported?: boolean
  requiresApiKey?: boolean
}

export const PROVIDER_SCAN_OVERRIDES: Partial<Record<ApiProvider, ProviderScanOverride>> = {
  openai: { requiresApiKey: true },
  anthropic: { scanPath: '/models', authType: 'anthropic', requiresApiKey: true },
  'google-gemini': { url: 'https://generativelanguage.googleapis.com/v1beta', scanPath: '/models', authType: 'google', requiresApiKey: true },
  deepseek: { requiresApiKey: true },
  qwen: { requiresApiKey: true },
  groq: { requiresApiKey: true },
  together: { requiresApiKey: true },
  fireworks: { requiresApiKey: true },
  mistral: { requiresApiKey: true },
  cohere: { url: 'https://api.cohere.com', scanPath: '/v1/models', requiresApiKey: true },
  moonshot: { requiresApiKey: true },
  zhipuai: { requiresApiKey: true },
  baidu: { requiresApiKey: true },
  yi: { requiresApiKey: true },
  perplexity: { scanUnsupported: true },
  minimax: { scanUnsupported: true },
}

export const PROVIDER_GROUPS: ProviderGroup[] = [
  { label: 'Lokalne', options: [
    { value: 'lmstudio', label: 'LMStudio', baseUrl: 'http://localhost:1234/v1', modelPlaceholder: 'nazwa-modelu (z listy w LMStudio)', apiKeyPlaceholder: 'Nie wymagany' },
    { value: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', modelPlaceholder: 'llama3.3', apiKeyPlaceholder: 'Nie wymagany' },
    { value: 'liquid-ai', label: 'Liquid AI / LFM lokalnie', baseUrl: 'http://localhost:1234/v1', modelPlaceholder: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF, LiquidAI/LFM2-2.6B-GGUF, LiquidAI/LFM2-8B-A1B-GGUF', apiKeyPlaceholder: 'Nie wymagany lokalnie' },
  ] },
  { label: 'OpenAI', options: [{ value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelPlaceholder: 'gpt-4o, gpt-4o-mini, o3, o4-mini', apiKeyPlaceholder: 'sk-...' }] },
  { label: 'Anthropic', options: [{ value: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', modelPlaceholder: 'claude-sonnet-4-5, claude-opus-4-5', apiKeyPlaceholder: 'sk-ant-...' }] },
  { label: 'Google', options: [{ value: 'google-gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelPlaceholder: 'gemini-2.5-pro, gemini-2.0-flash', apiKeyPlaceholder: 'AIza...' }] },
  { label: 'NVIDIA', options: [{ value: 'nvidia-nim', label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', modelPlaceholder: 'meta/llama-3.3-70b-instruct', apiKeyPlaceholder: 'nvapi-...' }] },
  { label: 'Chinese providers', options: [
    { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelPlaceholder: 'deepseek-chat, deepseek-reasoner', apiKeyPlaceholder: 'sk-...' },
    { value: 'qwen', label: 'Qwen / Alibaba Cloud', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelPlaceholder: 'qwen-max, qwen-plus, qwen-turbo', apiKeyPlaceholder: 'sk-...' },
    { value: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', modelPlaceholder: 'MiniMax-Text-01, abab6.5s-chat', apiKeyPlaceholder: '...' },
    { value: 'moonshot', label: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.cn/v1', modelPlaceholder: 'moonshot-v1-8k, moonshot-v1-128k', apiKeyPlaceholder: 'sk-...' },
    { value: 'zhipuai', label: 'Z.ai / GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelPlaceholder: 'glm-4-plus, glm-4-air', apiKeyPlaceholder: '...' },
    { value: 'baidu', label: 'Baidu / ERNIE', baseUrl: 'https://qianfan.baidubce.com/v2', modelPlaceholder: 'ernie-4.5-turbo-128k', apiKeyPlaceholder: '...' },
    { value: 'yi', label: '01.AI / Yi', baseUrl: 'https://api.lingyiwanwu.com/v1', modelPlaceholder: 'yi-large, yi-medium', apiKeyPlaceholder: '...' },
  ] },
  { label: 'Agregatorzy / Gateway', options: [
    { value: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelPlaceholder: 'qwen/qwen3.6-35b-a3b, google/gemini-pro', apiKeyPlaceholder: 'sk-or-...' },
    { value: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', modelPlaceholder: 'llama-3.3-70b-versatile, mixtral-8x7b', apiKeyPlaceholder: 'gsk_...' },
    { value: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', modelPlaceholder: 'meta-llama/Llama-3-70b-chat-hf', apiKeyPlaceholder: '...' },
    { value: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', modelPlaceholder: 'accounts/fireworks/models/llama-v3p1-70b-instruct', apiKeyPlaceholder: 'fw_...' },
    { value: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', modelPlaceholder: 'mistral-large-latest, codestral-latest', apiKeyPlaceholder: '...' },
    { value: 'cohere', label: 'Cohere', baseUrl: 'https://api.cohere.com/v2', modelPlaceholder: 'command-r-plus, command-r', apiKeyPlaceholder: '...' },
    { value: 'perplexity', label: 'Perplexity', baseUrl: 'https://api.perplexity.ai', modelPlaceholder: 'sonar-pro, sonar-reasoning', apiKeyPlaceholder: 'pplx-...' },
    { value: 'ai21', label: 'AI21', baseUrl: 'https://api.ai21.com/studio/v1', modelPlaceholder: 'jamba-1.5-large', apiKeyPlaceholder: '...' },
  ] },
  { label: 'Inne', options: [{ value: 'openai-compatible', label: 'OpenAI-compatible', baseUrl: '', modelPlaceholder: 'nazwa-modelu', apiKeyPlaceholder: 'sk-... lub odpowiedni klucz API' }] },
]

export const PROVIDER_OPTIONS = PROVIDER_GROUPS.flatMap((group) => group.options)
export const PROVIDER_PICKER_GROUPS = PROVIDER_GROUPS
  .map((group) => ({ ...group, options: group.options.filter((provider) => provider.value !== 'liquid-ai') }))
  .filter((group) => group.options.length > 0)
export const PROVIDER_LABELS = Object.fromEntries(PROVIDER_OPTIONS.map((provider) => [provider.value, provider.label])) as Record<ApiProvider, string>
export const PROVIDER_PRESETS = Object.fromEntries(PROVIDER_OPTIONS.map((provider) => [provider.value, provider.baseUrl])) as Record<ApiProvider, string>
export const PROVIDER_MODEL_PLACEHOLDERS = Object.fromEntries(PROVIDER_OPTIONS.map((provider) => [provider.value, provider.modelPlaceholder])) as Record<ApiProvider, string>
export const PROVIDER_API_KEY_PLACEHOLDERS = Object.fromEntries(PROVIDER_OPTIONS.map((provider) => [provider.value, provider.apiKeyPlaceholder])) as Record<ApiProvider, string>
