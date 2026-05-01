const { getModels, getPreference, savePreference, updateModel } = require('./database.cjs')

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const PRICING_CACHE_KEY = 'pricing_openrouter_cache'
const PRICING_UPDATED_KEY = 'pricing_openrouter_updated_at'
const PRICING_AUTO_REFRESH_KEY = 'pricing_auto_refresh_enabled'
const PRICING_REFRESH_INTERVAL_KEY = 'pricing_refresh_interval_hours'
const DEFAULT_REFRESH_INTERVAL_HOURS = 24
const LOCAL_PROVIDERS = new Set(['lmstudio', 'ollama', 'vllm'])

const PROVIDER_PREFIXES = {
  openai: ['openai'],
  anthropic: ['anthropic'],
  'google-gemini': ['google', 'google-gemini'],
  deepseek: ['deepseek'],
  qwen: ['qwen', 'alibaba'],
  minimax: ['minimax'],
  moonshot: ['moonshotai', 'moonshot', 'kimi'],
  zhipuai: ['z-ai', 'zhipuai', 'glm'],
  baidu: ['baidu'],
  xiaomi: ['xiaomi'],
  yi: ['01-ai', 'yi'],
  openrouter: [],
  groq: ['groq'],
  together: ['meta-llama', 'together'],
  fireworks: ['fireworks'],
  mistral: ['mistralai', 'mistral'],
  cohere: ['cohere'],
  perplexity: ['perplexity'],
  ai21: ['ai21'],
}

function normalizeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[:_\s]+/g, '-')
}

function modelCandidates(model) {
  const rawModelId = normalizeId(model.model_id)
  const rawName = normalizeId(model.name)
  const candidates = new Set([rawModelId, rawName].filter(Boolean))
  const provider = model.provider || ''
  if (provider === 'openrouter' && rawModelId) candidates.add(rawModelId)
  for (const prefix of PROVIDER_PREFIXES[provider] || []) {
    if (rawModelId) candidates.add(`${prefix}/${rawModelId}`)
    if (rawName) candidates.add(`${prefix}/${rawName}`)
  }
  return Array.from(candidates)
}

function parseOpenRouterModel(item) {
  const prompt = Number(item?.pricing?.prompt)
  const completion = Number(item?.pricing?.completion)
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null
  return {
    id: item.id,
    name: item.name || item.id,
    input_price_per_1m: Number.isFinite(prompt) ? Number((prompt * 1_000_000).toFixed(8)) : null,
    output_price_per_1m: Number.isFinite(completion) ? Number((completion * 1_000_000).toFixed(8)) : null,
    context_length: item.context_length || null,
  }
}

async function fetchOpenRouterPricing() {
  const response = await fetch(OPENROUTER_MODELS_URL, { headers: { 'user-agent': 'BenchForge pricing refresh' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const payload = await response.json()
  const models = (Array.isArray(payload?.data) ? payload.data : [])
    .map(parseOpenRouterModel)
    .filter(Boolean)
  if (models.length === 0) throw new Error('OpenRouter pricing response contains no models')
  const updatedAt = new Date().toISOString()
  savePreference(PRICING_CACHE_KEY, models)
  savePreference(PRICING_UPDATED_KEY, updatedAt)
  return { models, updatedAt }
}

function getCachedPricing() {
  const models = getPreference(PRICING_CACHE_KEY)
  const updatedAt = getPreference(PRICING_UPDATED_KEY)
  return { models: Array.isArray(models) ? models : [], updatedAt: typeof updatedAt === 'string' ? updatedAt : null }
}

function findPricingForModel(model, pricingModels) {
  const candidates = modelCandidates(model)
  if (candidates.length === 0) return null
  const byId = new Map(pricingModels.map((item) => [normalizeId(item.id), item]))
  for (const candidate of candidates) {
    const exact = byId.get(candidate)
    if (exact) return exact
  }
  const modelId = normalizeId(model.model_id)
  if (!modelId) return null
  return pricingModels.find((item) => normalizeId(item.id).endsWith(`/${modelId}`)) || null
}

function applyPricingToModels(pricingModels, updatedAt) {
  const models = getModels()
  let matched = 0
  for (const model of models) {
    if (model.mode !== 'api') continue
    if (LOCAL_PROVIDERS.has(model.provider)) continue
    const pricing = findPricingForModel(model, pricingModels)
    if (!pricing) continue
    updateModel(model.id, {
      input_price_per_1m: pricing.input_price_per_1m,
      output_price_per_1m: pricing.output_price_per_1m,
      pricing_source: 'openrouter',
      pricing_model_id: pricing.id,
      pricing_updated_at: updatedAt,
    })
    matched += 1
  }
  return { matched, totalModels: models.length }
}

async function refreshOpenRouterPricing({ apply = true } = {}) {
  const { models, updatedAt } = await fetchOpenRouterPricing()
  const applied = apply ? applyPricingToModels(models, updatedAt) : { matched: 0, totalModels: getModels().length }
  return { ok: true, source: 'openrouter', updatedAt, modelCount: models.length, ...applied }
}

async function refreshOpenRouterPricingIfStale() {
  const enabled = getPreference(PRICING_AUTO_REFRESH_KEY)
  if (enabled === false) return { skipped: true, reason: 'disabled' }
  const intervalHours = Number(getPreference(PRICING_REFRESH_INTERVAL_KEY) || DEFAULT_REFRESH_INTERVAL_HOURS)
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000
  const { updatedAt } = getCachedPricing()
  if (updatedAt && Date.now() - new Date(updatedAt).getTime() < intervalMs) return { skipped: true, reason: 'fresh', updatedAt }
  return refreshOpenRouterPricing({ apply: true })
}

function getPricingStatus() {
  const cache = getCachedPricing()
  return {
    source: 'openrouter',
    modelCount: cache.models.length,
    updatedAt: cache.updatedAt,
    autoRefresh: getPreference(PRICING_AUTO_REFRESH_KEY) !== false,
    intervalHours: Number(getPreference(PRICING_REFRESH_INTERVAL_KEY) || DEFAULT_REFRESH_INTERVAL_HOURS),
  }
}

module.exports = {
  refreshOpenRouterPricing,
  refreshOpenRouterPricingIfStale,
  getPricingStatus,
  findPricingForModel,
}
