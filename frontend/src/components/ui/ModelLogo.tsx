import React from 'react'
import type { AIModel, ApiProvider } from '@/types'

type LogoModel = Pick<AIModel, 'name' | 'provider' | 'model_id' | 'base_url'> | { name: string; provider?: string | null; model_id?: string | null; base_url?: string | null }

// Eager import — icons are inlined as base64 in the bundle (no separate HTTP requests)
const logoModules = import.meta.glob('../../assets/ai-logos/*', {
  eager: true,
  import: 'default',
}) as Record<string, string>

const logoByName = Object.fromEntries(
  Object.entries(logoModules).map(([path, url]) => {
    const fileName = path.split('/').pop() || ''
    const name = fileName.replace(/\.(svg|png|ico|webp|jpg|jpeg)$/i, '')
    return [name, url]
  }),
) as Record<string, string>

const PROVIDER_LOGOS: Record<string, string> = {
  lmstudio: 'lmstudio',
  ollama: 'ollama',
  vllm: 'vllm',
  openai: 'openai',
  anthropic: 'anthropic',
  'google-gemini': 'google-gemini',
  'nvidia-nim': 'nvidia',
  deepseek: 'deepseek',
  qwen: 'qwen',
  minimax: 'minimax',
  moonshot: 'kimi',
  zhipuai: 'zai',
  baidu: 'baidu',
  xiaomi: 'xiaomi',
  yi: 'yi',
  openrouter: 'openrouter',
  groq: 'groq',
  together: 'meta',
  fireworks: 'fireworks',
  mistral: 'mistral-ai',
  cohere: 'cohere',
  perplexity: 'perplexity',
  ai21: 'ai21-labs',
  'openai-compatible': 'openai',
}

const PROVIDER_ONLY_LOGOS = new Set(['lmstudio', 'ollama', 'vllm', 'openrouter', 'groq', 'together', 'fireworks', 'openai-compatible'])

const MODEL_KEYWORD_LOGOS: Array<[RegExp, string]> = [
  [/deepseek/i, 'deepseek'],
  [/qwen|通义|tongyi|alibaba/i, 'qwen'],
  [/claude|anthropic/i, 'anthropic'],
  [/gpt|openai|chatgpt|\bo[134]\b/i, 'openai'],
  [/gemini|google/i, 'google-gemini'],
  [/\bphi(?:[-\s]?\d|\b)|microsoft|msft/i, 'microsoft'],
  [/nvidia|\bnim\b/i, 'nvidia'],
  [/mistral|mixtral|codestral/i, 'mistral-ai'],
  [/llama|meta[-\s]?llama|meta/i, 'meta'],
  [/grok|xai|x\.ai/i, 'xai'],
  [/cohere|command-r/i, 'cohere'],
  [/perplexity|sonar/i, 'perplexity'],
  [/moonshot|kimi/i, 'kimi'],
  [/zhipu|z\.ai|zai|glm|bigmodel/i, 'zai'],
  [/baidu|ernie|qianfan/i, 'baidu'],
  [/xiaomi|mimo/i, 'xiaomi'],
  [/yi-|\byi\b|01\.ai|lingyi/i, 'yi'],
  [/minimax|abab/i, 'minimax'],
  [/ai21|jamba/i, 'ai21-labs'],
  [/liquid|lfm/i, 'liquid-ai'],
  [/hermes|nous[-\s]?hermes/i, 'hermes'],
  [/huggingface|hugging\s*face/i, 'huggingface'],
]

const RUNTIME_KEYWORD_LOGOS: Array<[RegExp, string]> = [
  [/\b(lm\s*studio|lmstudio)\b/i, 'lmstudio'],
  [/\bollama\b/i, 'ollama'],
  [/\bvllm\b/i, 'vllm'],
  [/\b(openrouter)\b/i, 'openrouter'],
  [/\b(groq)\b/i, 'groq'],
  [/\b(fireworks)\b/i, 'fireworks'],
  [/\b(together)\b/i, 'meta'],
]

export const getModelLogo = (model: LogoModel | null | undefined) => {
  if (!model) return null
  const modelHaystack = [model.model_id, model.name].filter(Boolean).join(' ')
  const modelMatch = MODEL_KEYWORD_LOGOS.find(([pattern, logo]) => pattern.test(modelHaystack) && logoByName[logo])
  if (modelMatch) return logoByName[modelMatch[1]]

  const providerLogo = model.provider ? PROVIDER_LOGOS[model.provider] : null
  if (providerLogo && logoByName[providerLogo]) return logoByName[providerLogo]

  const haystack = [model.name, model.provider, model.model_id, model.base_url].filter(Boolean).join(' ')
  const match = [...MODEL_KEYWORD_LOGOS, ...RUNTIME_KEYWORD_LOGOS].find(([pattern, logo]) => pattern.test(haystack) && logoByName[logo])
  return match ? logoByName[match[1]] : null
}

export const getProviderLogo = (provider?: string | null) => {
  const logoName = provider ? PROVIDER_LOGOS[provider] : null
  return logoName ? logoByName[logoName] || null : null
}

interface ModelLogoProps {
  model?: Pick<AIModel, 'name' | 'provider' | 'model_id' | 'base_url'> | null
  provider?: ApiProvider | string | null
  modelId?: string | null
  name?: string | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
  showProviderBadge?: boolean
}

const SIZE_CLASSES = {
  sm: 'h-7 w-7',
  md: 'h-9 w-9',
  lg: 'h-12 w-12',
}

export const ModelLogo: React.FC<ModelLogoProps> = React.memo(({ model, provider, modelId, name, size = 'md', className = '', showProviderBadge = true }) => {
  const sourceModel: LogoModel = model || { name: name || '', provider: provider || undefined, model_id: modelId || null, base_url: null }
  const logo = getModelLogo(sourceModel)
  const providerValue = sourceModel.provider || provider
  const providerLogo = getProviderLogo(providerValue)
  const shouldShowProviderBadge = showProviderBadge && providerLogo && providerValue && PROVIDER_ONLY_LOGOS.has(String(providerValue)) && providerLogo !== logo
  const sizeClass = SIZE_CLASSES[size]
  const badgeClass = size === 'sm' ? 'h-3.5 w-3.5 -bottom-1 -right-1 p-0.5' : size === 'lg' ? 'h-5 w-5 -bottom-1 -right-1 p-0.5' : 'h-4 w-4 -bottom-1 -right-1 p-0.5'

  if (!logo) {
    return <span className={`${sizeClass} ${className} relative inline-flex shrink-0 items-center justify-center rounded-xl border border-slate-700/50 bg-slate-950/40 text-sm`}>🤖{shouldShowProviderBadge && <span className={`${badgeClass} absolute inline-flex items-center justify-center overflow-hidden rounded-full border border-slate-700/60 bg-white`}><img src={providerLogo} alt="" className="h-full w-full object-contain" /></span>}</span>
  }

  return <span className={`${sizeClass} ${className} relative inline-flex shrink-0 items-center justify-center rounded-xl border border-slate-700/50 bg-white/95 p-1.5`}><img src={logo} alt="" className="h-full w-full object-contain" />{shouldShowProviderBadge && <span className={`${badgeClass} absolute inline-flex items-center justify-center overflow-hidden rounded-full border border-slate-700/60 bg-white`}><img src={providerLogo} alt="" className="h-full w-full object-contain" /></span>}</span>
})

ModelLogo.displayName = 'ModelLogo'
