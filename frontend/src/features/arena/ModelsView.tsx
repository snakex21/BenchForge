// ============================================================
// ModelsView — lista i zarządzanie modelami AI
// ============================================================

import React, { useEffect, useMemo, useState } from 'react'
import { useModelStore } from '@/store/modelStore'
import { useUIStore } from '@/store/uiStore'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { ModelLogo, getProviderLogo } from '@/components/ui/ModelLogo'
import type { AIModel, ApiProvider, ModelMode } from '@/types'
import { useTranslation } from '@/i18n'
import { PROVIDER_API_KEY_PLACEHOLDERS, PROVIDER_LABELS, PROVIDER_MODEL_PLACEHOLDERS, PROVIDER_OPTIONS, PROVIDER_PICKER_GROUPS, PROVIDER_PRESETS, PROVIDER_SCAN_OVERRIDES } from '@/features/models/providerConfig'

const LOCAL_PROVIDERS = new Set<ApiProvider>(['lmstudio', 'ollama', 'vllm'])

interface SavedProviderConfig {
  apiKey?: string
  baseUrl?: string
}

const MODE_BADGE_VARIANTS: Record<ModelMode, 'info' | 'warning' | 'success'> = {
  api: 'info',
  manual: 'warning',
}

const MODE_LABELS: Record<ModelMode, string> = {
  api: 'API',
  manual: 'Manual',
}

const defaultFormState = {
  name: '',
  mode: 'api' as ModelMode,
  provider: 'lmstudio' as ApiProvider,
  base_url: PROVIDER_PRESETS.lmstudio,
  api_key: '',
  model_id: '',
  input_price_per_1m: '',
  output_price_per_1m: '',
}

const ProviderLogo: React.FC<{ provider: ApiProvider; className?: string }> = ({ provider, className = '' }) => {
  const logo = getProviderLogo(provider)
  if (!logo) return <span className={`${className} inline-flex h-6 w-6 items-center justify-center rounded-lg border border-slate-700/50 bg-slate-950/40 text-xs`}>⚙️</span>
  return <span className={`${className} inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-lg border border-slate-700/50 bg-white/95 p-1`}><img src={logo} alt="" className="h-full w-full object-contain" /></span>
}

const maskApiKey = (apiKey?: string | null) => {
  const value = apiKey?.trim()
  if (!value) return '—'
  if (value.length <= 8) return '•'.repeat(Math.max(4, value.length))
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(16, value.length - 8))}${value.slice(-4)}`
}

const parsePrice = (value: string) => {
  if (value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null
}

const ChevronIcon: React.FC<React.SVGProps<SVGSVGElement>> = ({ className = '', ...props }) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <path d="M5.75 7.5 10 11.75 14.25 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

type FormState = typeof defaultFormState

interface ScannedModel {
  provider: ApiProvider
  modelId: string
}

export const ModelsView: React.FC = () => {
  const models = useModelStore((state) => state.models)
  const addModel = useModelStore((state) => state.addModel)
  const removeModel = useModelStore((state) => state.removeModel)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const { t } = useTranslation()

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(defaultFormState)
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const [isTestingDraft, setIsTestingDraft] = useState(false)
  const [testingModelId, setTestingModelId] = useState<number | null>(null)
  const [cardTestStatuses, setCardTestStatuses] = useState<Record<number, string>>({})
  const [isScanning, setIsScanning] = useState(false)
  const [scanModalOpen, setScanModalOpen] = useState(false)
  const [scannedModels, setScannedModels] = useState<ScannedModel[]>([])
  const [selectedScanned, setSelectedScanned] = useState<string[]>([])
  const [scanErrors, setScanErrors] = useState<Record<string, string>>({})
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const [showDraftApiKey, setShowDraftApiKey] = useState(false)
  const [visibleApiKeys, setVisibleApiKeys] = useState<Record<number, boolean>>({})
  const [keyActionStatuses, setKeyActionStatuses] = useState<Record<number, string>>({})
  const [pricingStatus, setPricingStatus] = useState<string | null>(null)
  const [isRefreshingPricing, setIsRefreshingPricing] = useState(false)

  const isApiMode = form.mode === 'api'
  const isLocalProvider = isApiMode && LOCAL_PROVIDERS.has(form.provider)

  const savedProviderConfigs = useMemo<Partial<Record<ApiProvider, SavedProviderConfig>>>(() => {
    const configs: Partial<Record<ApiProvider, SavedProviderConfig>> = {}
    const sortedModels = [...models].sort((left, right) => right.id - left.id)

    for (const model of sortedModels) {
      if (model.mode !== 'api' || !model.provider) continue
      const config = configs[model.provider] || {}
      const apiKey = model.api_key?.trim()
      const baseUrl = model.base_url?.trim()

      if (!config.apiKey && apiKey) config.apiKey = apiKey
      if (!config.baseUrl && baseUrl) config.baseUrl = baseUrl
      configs[model.provider] = config
    }

    return configs
  }, [models])

  const lastUsedProvider = useMemo<ApiProvider>(() => {
    const sortedModels = [...models].sort((left, right) => right.id - left.id)
    return sortedModels.find((model) => model.mode === 'api' && model.provider)?.provider || 'lmstudio'
  }, [models])

  const getProviderDefaults = (provider: ApiProvider) => ({
    baseUrl: savedProviderConfigs[provider]?.baseUrl || PROVIDER_PRESETS[provider],
    apiKey: savedProviderConfigs[provider]?.apiKey || '',
  })

  const createFormDefaults = (provider: ApiProvider = lastUsedProvider): FormState => {
    const defaults = getProviderDefaults(provider)
    return {
      ...defaultFormState,
      provider,
      base_url: defaults.baseUrl,
      api_key: defaults.apiKey,
    }
  }

  const currentSavedProviderConfig = savedProviderConfigs[form.provider]
  const canUseSavedApiKey = Boolean(currentSavedProviderConfig?.apiKey && form.api_key !== currentSavedProviderConfig.apiKey)
  const isUsingSavedApiKey = Boolean(currentSavedProviderConfig?.apiKey && form.api_key === currentSavedProviderConfig.apiKey)

  useEffect(() => {
    let cancelled = false
    const loadDiscovered = async () => {
      const cached = await window.db?.getDiscoveredModels?.()
      if (cancelled || !cached) return
      setScannedModels(cached
        .filter((model): model is { provider: ApiProvider; modelId: string } => Boolean(model.modelId) && PROVIDER_OPTIONS.some((provider) => provider.value === model.provider))
        .map((model) => ({ provider: model.provider, modelId: model.modelId })))
    }
    void loadDiscovered()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    void window.benchforge?.getPricingStatus?.().then((status) => {
      if (status?.updatedAt) setPricingStatus(t('models.pricingUpdated', { date: new Date(status.updatedAt).toLocaleString() }))
    })
  }, [t])

  const canSubmit = useMemo(() => {
    if (!form.name.trim()) return false
    if (form.mode === 'manual') return true

    return Boolean(form.provider && form.base_url.trim() && form.model_id.trim())
  }, [form])

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleModeChange = (mode: ModelMode) => {
    if (mode === 'manual') {
      setForm((current) => ({
        ...current,
        mode,
        provider: 'lmstudio',
        base_url: '',
        api_key: '',
        model_id: '',
        input_price_per_1m: '',
        output_price_per_1m: '',
      }))
      setShowDraftApiKey(false)
      setTestStatus(null)
      return
    }

    setForm((current) => ({
      ...current,
      mode,
      provider: current.provider || 'lmstudio',
      base_url: getProviderDefaults(current.provider || 'lmstudio').baseUrl,
      api_key: getProviderDefaults(current.provider || 'lmstudio').apiKey || current.api_key,
    }))
    setTestStatus(null)
  }

  const handleProviderChange = (provider: ApiProvider) => {
    const defaults = getProviderDefaults(provider)
    setForm((current) => ({
      ...current,
      provider,
      base_url: defaults.baseUrl,
      api_key: current.provider === provider ? current.api_key : defaults.apiKey,
      name: '',
      model_id: '',
    }))
    setTestStatus(null)
    setShowDraftApiKey(false)
    setModelPickerOpen(false)
    setProviderPickerOpen(false)
  }

  const openModelForm = (provider: ApiProvider = lastUsedProvider) => {
    setForm(createFormDefaults(provider))
    setShowDraftApiKey(false)
    setTestStatus(null)
    setModelPickerOpen(false)
    setProviderPickerOpen(false)
    setShowForm(true)
  }

  const closeModelForm = () => {
    setShowForm(false)
    setForm(defaultFormState)
    setTestStatus(null)
    setModelPickerOpen(false)
    setProviderPickerOpen(false)
    setShowDraftApiKey(false)
  }

  const scanKey = (model: ScannedModel) => `${model.provider}:${model.modelId}`

  const modelSuggestions = useMemo(() => {
    const query = form.name.trim().toLowerCase()
    return scannedModels
      .filter((model) => model.provider === form.provider)
      .filter((model) => !query || model.modelId.toLowerCase().includes(query) || PROVIDER_LABELS[model.provider].toLowerCase().includes(query))
  }, [form.name, form.provider, scannedModels])

  const fillFormFromScannedModel = (model: ScannedModel) => {
    const defaults = getProviderDefaults(model.provider)
    setForm((current) => ({
      name: `${PROVIDER_LABELS[model.provider]} · ${model.modelId}`,
      mode: 'api',
      provider: model.provider,
      base_url: defaults.baseUrl,
      api_key: current.provider === model.provider ? current.api_key || defaults.apiKey : defaults.apiKey,
      model_id: model.modelId,
      input_price_per_1m: '',
      output_price_per_1m: '',
    }))
    setShowForm(true)
    setScanModalOpen(false)
    setTestStatus(null)
  }

  const handleScanModels = async (scanAll = false) => {
    if (!window.db) return
    setIsScanning(true)
    setScanErrors({})
    try {
      const endpoints = PROVIDER_OPTIONS
        .filter((provider) => {
          const savedBaseUrl = savedProviderConfigs[provider.value]?.baseUrl
          const selectedBaseUrl = provider.value === form.provider ? form.base_url.trim() : ''
          const hasBaseUrl = Boolean(provider.baseUrl || savedBaseUrl || selectedBaseUrl)
          return hasBaseUrl && (scanAll || provider.value === form.provider || provider.value === 'lmstudio' || provider.value === 'ollama' || provider.value === 'vllm')
        })
        .map((provider) => {
          const override = PROVIDER_SCAN_OVERRIDES[provider.value] || {}
          const savedConfig = savedProviderConfigs[provider.value]
          const selectedProvider = provider.value === form.provider
          const sourceBaseUrl = selectedProvider ? form.base_url.trim() || savedConfig?.baseUrl || provider.baseUrl : savedConfig?.baseUrl || provider.baseUrl
          const sourceApiKey = selectedProvider ? form.api_key.trim() || savedConfig?.apiKey : savedConfig?.apiKey
          return {
            key: provider.value,
            name: provider.label,
            url: override.url || (provider.value === 'ollama' ? sourceBaseUrl.replace(/\/v1$/i, '') : sourceBaseUrl),
            type: provider.value === 'ollama' ? 'ollama' : 'openai',
            apiKey: sourceApiKey || undefined,
            scanPath: override.scanPath,
            authType: override.authType,
            scanUnsupported: override.scanUnsupported,
            requiresApiKey: override.requiresApiKey,
          }
        })
      console.group(`[BenchForge] Skanowanie modeli: ${scanAll ? 'wszyscy providerzy' : 'lokalne + wybrany provider'}`)
      console.table(endpoints.map((endpoint) => ({ provider: endpoint.key, name: endpoint.name, url: endpoint.url, auth: endpoint.apiKey ? 'API key' : 'missing' })))
      const result = await window.db.scanModels({ endpoints })
      const found: ScannedModel[] = PROVIDER_OPTIONS.flatMap((provider) => {
        const modelsForProvider = result[provider.value]
        return Array.isArray(modelsForProvider) ? modelsForProvider.map((modelId) => ({ provider: provider.value, modelId: String(modelId) })) : []
      })
      console.table(found.map((model) => ({ provider: model.provider, model: model.modelId })))
      if (result.errors && Object.keys(result.errors).length > 0) console.warn('[BenchForge] Scan errors:', result.errors)
      console.groupEnd()
      setScannedModels(found)
      setSelectedScanned([])
      setScanErrors(result.errors || {})
      setScanModalOpen(false)
      setModelPickerOpen(false)
      setProviderPickerOpen(false)
    } finally {
      setIsScanning(false)
    }
  }

  const handleRefreshPricing = async () => {
    setIsRefreshingPricing(true)
    setPricingStatus(t('models.pricingRefreshing'))
    try {
      const result = await window.benchforge?.refreshOpenRouterPricing?.()
      await useModelStore.getState().loadFromDb()
      setPricingStatus(t('models.pricingRefreshed', { matched: result?.matched ?? 0, total: result?.modelCount ?? 0 }))
    } catch (error) {
      setPricingStatus(t('models.pricingRefreshFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setIsRefreshingPricing(false)
    }
  }

  const handleAddSelectedScanned = async () => {
    const selected = scannedModels.filter((model) => selectedScanned.includes(scanKey(model)))
    for (const model of selected) {
      const defaults = getProviderDefaults(model.provider)
      const baseUrl = model.provider === form.provider ? form.base_url.trim() || defaults.baseUrl : defaults.baseUrl
      const apiKey = model.provider === form.provider ? form.api_key.trim() || defaults.apiKey : defaults.apiKey
      await addModel({
        name: `${PROVIDER_LABELS[model.provider]} · ${model.modelId}`,
        mode: 'api',
        provider: model.provider,
        base_url: baseUrl,
        api_key: apiKey || null,
        model_id: model.modelId,
      })
    }
    setScanModalOpen(false)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return

    const payload: Omit<AIModel, 'id' | 'created_at'> = {
      name: form.name.trim(),
      mode: form.mode,
      provider: form.mode === 'api' ? form.provider : undefined,
      base_url: form.mode === 'api' ? form.base_url.trim() : null,
      api_key: form.mode === 'api' ? form.api_key.trim() || null : null,
      model_id: form.mode === 'api' ? form.model_id.trim() : null,
      input_price_per_1m: form.mode === 'api' && !isLocalProvider ? parsePrice(form.input_price_per_1m) : null,
      output_price_per_1m: form.mode === 'api' && !isLocalProvider ? parsePrice(form.output_price_per_1m) : null,
      pricing_source: form.mode === 'api' && !isLocalProvider && (form.input_price_per_1m !== '' || form.output_price_per_1m !== '') ? 'manual' : null,
      pricing_model_id: null,
      pricing_updated_at: form.mode === 'api' && !isLocalProvider && (form.input_price_per_1m !== '' || form.output_price_per_1m !== '') ? new Date().toISOString() : null,
    }

    if (form.mode === 'manual') {
      payload.provider = undefined
      payload.base_url = null
      payload.api_key = null
      payload.model_id = null
      payload.input_price_per_1m = null
      payload.output_price_per_1m = null
      payload.pricing_source = null
      payload.pricing_model_id = null
      payload.pricing_updated_at = null
    }

    await addModel(payload)
    setForm(defaultFormState)
    setShowForm(false)
    setTestStatus(null)
    setModelPickerOpen(false)
    setProviderPickerOpen(false)
    setShowDraftApiKey(false)
  }

  const handleCopyApiKey = async (model: AIModel) => {
    const apiKey = model.api_key?.trim()
    if (!apiKey) return

    try {
      await navigator.clipboard.writeText(apiKey)
      setKeyActionStatuses((current) => ({ ...current, [model.id]: t('models.apiKeyCopied') }))
    } catch {
      setKeyActionStatuses((current) => ({ ...current, [model.id]: t('models.apiKeyCopyFailed') }))
    }
  }

  const handleDraftTest = async () => {
    if (!window.db || form.mode !== 'api') return

    setIsTestingDraft(true)
    setTestStatus(t('models.testingConnection'))

    const result = await window.db.testConnection({
      modelConfig: {
        name: form.name.trim() || t('models.newModel'),
        mode: 'api',
        provider: form.provider,
        base_url: form.base_url.trim(),
        api_key: form.api_key.trim() || null,
        model_id: form.model_id.trim() || null,
      },
    })

    setTestStatus(result.ok ? t('models.connectionOk') : t('models.connectionError', { error: result.error || '' }))
    setIsTestingDraft(false)
  }

  const handleSavedModelTest = async (modelId: number) => {
    if (!window.db) return

    setTestingModelId(modelId)
    setCardTestStatuses((current) => ({ ...current, [modelId]: t('models.testingConnection') }))

    const result = await window.db.testConnection({ modelId })
    setCardTestStatuses((current) => ({
      ...current,
      [modelId]: result.ok ? t('models.connectionOkShort') : t('models.errorShort', { error: result.error || '' }),
    }))
    setTestingModelId(null)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setActiveView('arena')}>
            {t('common.backToArena')}
          </Button>
          <h2 className="text-xl font-bold text-slate-100">{t('models.title')}</h2>
        </div>
        {models.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void handleRefreshPricing()} disabled={isRefreshingPricing}>
              {isRefreshingPricing ? t('models.pricingRefreshing') : t('models.refreshPricing')}
            </Button>
            <Button onClick={() => showForm ? closeModelForm() : openModelForm()}>
              {showForm ? t('common.cancel') : t('models.addModel')}
            </Button>
          </div>
        )}
      </div>
      {pricingStatus && <div className="rounded-lg border border-slate-700/40 bg-slate-950/30 p-3 text-sm text-slate-400">{pricingStatus}</div>}

      {scanModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-700/60 bg-[#161822] p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">{t('models.foundLocal')}</h3>
                <p className="text-sm text-slate-500">{t('models.scanDescription')}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setScanModalOpen(false)}>{t('common.close')}</Button>
            </div>

            <div className="space-y-3">
              {Object.entries(scanErrors).length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                  {Object.entries(scanErrors).map(([provider, error]) => <p key={provider}>{provider}: {error}</p>)}
                </div>
              )}

              {scannedModels.length === 0 ? (
                <p className="text-sm text-slate-500">{t('models.noScanned')}</p>
              ) : (
                <div className="max-h-96 space-y-2 overflow-auto">
                  {scannedModels.map((model) => {
                    const key = scanKey(model)
                    return (
                      <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-slate-700/40 px-3 py-2">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                          <input type="checkbox" checked={selectedScanned.includes(key)} onChange={() => setSelectedScanned((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])} />
                          <ModelLogo provider={model.provider} modelId={model.modelId} name={model.modelId} size="sm" />
                          <div className="min-w-0">
                            <p className="truncate text-sm text-slate-200">{model.modelId}</p>
                            <p className="text-xs text-slate-500">{PROVIDER_LABELS[model.provider]} · {PROVIDER_PRESETS[model.provider]}</p>
                          </div>
                        </label>
                        <Button variant="secondary" size="sm" onClick={() => fillFormFromScannedModel(model)}>{t('common.add')}</Button>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="flex justify-end gap-3">
                <Button variant="ghost" onClick={() => setScanModalOpen(false)}>{t('common.cancel')}</Button>
                <Button onClick={() => void handleAddSelectedScanned()} disabled={selectedScanned.length === 0}>{t('models.addSelected')}</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={closeModelForm}>
          <div className="max-h-[92vh] w-full max-w-3xl overflow-auto rounded-2xl border border-slate-700/60 bg-[#161822] shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-slate-700/40 p-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">{t('models.newModel')}</h3>
                <p className="mt-1 text-sm text-slate-500">{t('models.newModelDescription')}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" size="sm" onClick={() => void handleScanModels(false)} disabled={isScanning}>{isScanning ? t('models.scanning') : t('models.scanModels')}</Button>
                <Button variant="ghost" size="sm" onClick={() => void handleScanModels(true)} disabled={isScanning}>{isScanning ? t('models.scanning') : t('models.scanAll')}</Button>
                <Button variant="ghost" size="sm" onClick={closeModelForm}>{t('common.close')}</Button>
              </div>
            </div>
            <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4 p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="relative">
                <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.modelName')}</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => { updateForm('name', event.target.value); setModelPickerOpen(true) }}
                  onFocus={() => { if (form.name.trim()) setModelPickerOpen(true) }}
                  placeholder={t('models.modelNamePlaceholder')}
                  className="h-12 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 pr-11 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
                <button type="button" className="absolute right-2 top-[1.85rem] flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-100" onClick={() => setModelPickerOpen((open) => !open)} aria-label={t('models.showScanned')}><ChevronIcon className={`h-4 w-4 transition-transform duration-200 ${modelPickerOpen ? 'rotate-180' : ''}`} /></button>
                {modelPickerOpen && (
                  <div className="absolute z-[70] mt-2 max-h-56 w-full overflow-auto rounded-xl border border-slate-700/60 bg-[#101219] p-2 shadow-2xl">
                    {modelSuggestions.length === 0 ? <p className="px-2 py-2 text-xs text-slate-500">{t('models.noMatchingScanned')}</p> : modelSuggestions.map((model) => <button key={scanKey(model)} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-slate-300 hover:bg-slate-800" onClick={() => { setForm((current) => ({ ...current, name: `${PROVIDER_LABELS[model.provider]} · ${model.modelId}`, model_id: model.modelId })); setModelPickerOpen(false); setTestStatus(null) }}><ModelLogo provider={model.provider} modelId={model.modelId} name={model.modelId} size="sm" /><span className="min-w-0"><span className="block truncate">{model.modelId}</span><span className="block truncate text-[11px] text-slate-500">{PROVIDER_LABELS[model.provider]}</span></span></button>)}
                  </div>
                )}
              </div>
              <div className="relative">
                <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.mode')}</label>
                <select
                  value={form.mode}
                  onChange={(event) => handleModeChange(event.target.value as ModelMode)}
                  className="h-12 w-full appearance-none rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 pr-11 text-sm text-slate-200 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  <option value="api">{t('models.modeApi')}</option>
                  <option value="manual">{t('models.modeManual')}</option>
                </select>
                <span className="pointer-events-none absolute right-3 top-[1.95rem] flex h-5 w-5 items-center justify-center rounded-md text-slate-400/90"><ChevronIcon className="h-4 w-4" /></span>
              </div>
            </div>

            {isApiMode && (
              <>
                <div className="grid gap-3 rounded-xl border border-slate-700/40 bg-slate-950/30 p-3 md:grid-cols-2">
                  <div className="flex items-center gap-3">
                    <ModelLogo provider={form.provider} modelId={form.model_id} name={`${form.name} ${form.model_id}`} size="lg" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('models.modelIcon')}</p>
                      <p className="truncate text-sm text-slate-200">{form.model_id || form.name || t('models.detectByModelId')}</p>
                      <p className="text-xs text-slate-500">{t('models.logoHint')}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <ProviderLogo provider={form.provider} className="h-12 w-12 rounded-xl" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('models.providerRuntime')}</p>
                      <p className="truncate text-sm text-slate-200">{PROVIDER_LABELS[form.provider]}</p>
                      <p className="text-xs text-slate-500">{t('models.providerIconHint')}</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-400"><ProviderLogo provider={form.provider} />{t('models.providerLabel')}</label>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => { setProviderPickerOpen((open) => !open); setModelPickerOpen(false) }}
                        className="flex h-12 w-full items-center gap-3 rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 pr-11 text-left text-sm text-slate-200 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                        aria-haspopup="listbox"
                        aria-expanded={providerPickerOpen}
                      >
                        <ProviderLogo provider={form.provider} className="h-7 w-7 rounded-lg" />
                        <span className="min-w-0 truncate">{PROVIDER_LABELS[form.provider]}</span>
                      </button>
                      <span className="pointer-events-none absolute right-3 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-slate-400/90"><ChevronIcon className={`h-4 w-4 transition-transform duration-200 ${providerPickerOpen ? 'rotate-180' : ''}`} /></span>
                      {providerPickerOpen && (
                        <div className="absolute z-[70] mt-2 max-h-72 w-full overflow-auto rounded-xl border border-slate-700/60 bg-[#101219] p-2 shadow-2xl" role="listbox">
                          {PROVIDER_PICKER_GROUPS.map((group) => (
                            <div key={group.label} className="py-1 first:pt-0 last:pb-0">
                              <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 first:pt-0">{group.label}</p>
                              {group.options.map((provider) => {
                                const selected = provider.value === form.provider
                                return (
                                  <button
                                    key={provider.value}
                                    type="button"
                                    role="option"
                                    aria-selected={selected}
                                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${selected ? 'bg-indigo-500/15 text-slate-100 ring-1 ring-indigo-500/30' : 'text-slate-300 hover:bg-slate-800'}`}
                                    onClick={() => handleProviderChange(provider.value)}
                                  >
                                    <ProviderLogo provider={provider.value} className="h-7 w-7 rounded-lg" />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate">{provider.label}</span>
                                      {savedProviderConfigs[provider.value]?.apiKey && <span className="block truncate text-[11px] text-emerald-300">🔑 {t('models.savedKeyBadge')}</span>}
                                    </span>
                                     {selected && <span className="text-xs text-indigo-300">{t('models.selectedProvider')}</span>}
                                  </button>
                                )
                              })}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.modelIdLabel')}</label>
                    <input
                      type="text"
                      value={form.model_id}
                      onChange={(event) => updateForm('model_id', event.target.value)}
                      placeholder={PROVIDER_MODEL_PLACEHOLDERS[form.provider]}
                      className="mt-2 h-12 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.baseUrlLabel')}</label>
                  <input
                    type="text"
                    value={form.base_url}
                    onChange={(event) => updateForm('base_url', event.target.value)}
                    placeholder={PROVIDER_PRESETS[form.provider] || 'https://example.com/v1'}
                    className="h-12 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>

                {isLocalProvider ? (
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-200">
                    {t('models.localPricingInfo')}
                  </div>
                ) : (
                  <div className="grid gap-3 rounded-xl border border-slate-700/40 bg-slate-950/30 p-3 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.inputPrice')}</label>
                      <input
                        type="number"
                        step="0.000001"
                        min="0"
                        value={form.input_price_per_1m}
                        onChange={(event) => updateForm('input_price_per_1m', event.target.value)}
                        placeholder="0.150000"
                        className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.outputPrice')}</label>
                      <input
                        type="number"
                        step="0.000001"
                        min="0"
                        value={form.output_price_per_1m}
                        onChange={(event) => updateForm('output_price_per_1m', event.target.value)}
                        placeholder="0.600000"
                        className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                      />
                    </div>
                    <p className="md:col-span-2 text-xs text-slate-500">{t('models.pricingHint')}</p>
                  </div>
                )}

                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="block text-xs font-medium text-slate-400">{t('models.apiKey')}</label>
                    {currentSavedProviderConfig?.apiKey && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">🔑 {t('models.apiKeySaved')}</span>}
                  </div>
                  <div className="relative">
                    <input
                      type={showDraftApiKey ? 'text' : 'password'}
                      value={form.api_key}
                      onChange={(event) => updateForm('api_key', event.target.value)}
                      placeholder={PROVIDER_API_KEY_PLACEHOLDERS[form.provider]}
                      className="h-12 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 pr-24 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowDraftApiKey((visible) => !visible)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
                    >
                      {showDraftApiKey ? t('models.hideApiKey') : t('models.showApiKey')}
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>{currentSavedProviderConfig?.apiKey ? (isUsingSavedApiKey ? t('models.apiKeyReused') : t('models.apiKeySavedHint')) : t('models.apiKeyNoSavedHint')}</span>
                    {canUseSavedApiKey && (
                      <button type="button" onClick={() => updateForm('api_key', currentSavedProviderConfig?.apiKey || '')} className="text-emerald-300 hover:text-emerald-200">
                        {t('models.useSavedKey')}
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void handleDraftTest()}
                    disabled={!form.base_url.trim() || !form.model_id.trim() || isTestingDraft}
                  >
                    {t('models.testConnection')}
                  </Button>
                  {testStatus && <p className="text-xs text-slate-500">{testStatus}</p>}
                </div>
              </>
            )}

            {form.mode === 'manual' && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
                {t('models.manualInfo')}
              </div>
            )}

              <div className="flex justify-end gap-2 border-t border-slate-700/40 pt-4">
                <Button type="button" variant="ghost" onClick={closeModelForm}>{t('common.cancel')}</Button>
                <Button type="submit" disabled={!canSubmit}>{t('models.addModel')}</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {models.length === 0 ? (
        <EmptyState
          icon="plus"
          title={t('models.emptyTitle')}
          description={t('models.emptyDescription')}
          actionLabel={t('models.addFirst')}
          onAction={() => openModelForm()}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {models.map((model) => (
            <Card key={model.id} padding>
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <ModelLogo model={model} size="lg" />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-slate-200">{model.name}</h3>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Badge variant={MODE_BADGE_VARIANTS[model.mode]}>{MODE_LABELS[model.mode]}</Badge>
                      {model.provider && <Badge variant="neutral">{PROVIDER_LABELS[model.provider]}</Badge>}
                    </div>
                    {model.model_id && <p className="mt-2 text-xs text-slate-500">{t('models.modelIdDisplay')} {model.model_id}</p>}
                    {model.base_url && <p className="mt-1 truncate text-xs text-slate-500">{t('models.baseUrlDisplay')} {model.base_url}</p>}
                    {(model.input_price_per_1m || model.output_price_per_1m) && (
                      <p className="mt-1 text-xs text-emerald-300">
                        {t('models.pricingShort', { input: model.input_price_per_1m ?? '—', output: model.output_price_per_1m ?? '—' })}
                      </p>
                    )}
                    {model.pricing_source && <p className="mt-1 text-[11px] text-slate-600">{model.pricing_source}{model.pricing_model_id ? ` · ${model.pricing_model_id}` : ''}</p>}
                  </div>
                  <button
                    onClick={() => void removeModel(model.id)}
                    className="p-1 text-slate-600 transition-colors hover:text-red-400"
                    title={t('models.deleteModel')}
                  >
                    ✕
                  </button>
                </div>

                {model.mode === 'api' && (
                  <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{t('models.apiKey')}</p>
                      {model.api_key && (
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setVisibleApiKeys((current) => ({ ...current, [model.id]: !current[model.id] }))}>
                            {visibleApiKeys[model.id] ? t('models.hideApiKey') : t('models.showApiKey')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void handleCopyApiKey(model)}>
                            {t('models.copyApiKey')}
                          </Button>
                        </div>
                      )}
                    </div>
                    {model.api_key ? (
                      <code className="block break-all rounded-lg border border-slate-800 bg-black/30 px-3 py-2 text-xs text-slate-300">
                        {visibleApiKeys[model.id] ? model.api_key : maskApiKey(model.api_key)}
                      </code>
                    ) : (
                      <p className="text-xs text-slate-500">{t('models.noApiKeySaved')}</p>
                    )}
                    {keyActionStatuses[model.id] && <p className="mt-2 text-xs text-slate-500">{keyActionStatuses[model.id]}</p>}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleSavedModelTest(model.id)}
                    disabled={model.mode !== 'api' || testingModelId === model.id}
                  >
                    {t('models.test')}
                  </Button>
                  {cardTestStatuses[model.id] && (
                    <p className="text-xs text-slate-500">{cardTestStatuses[model.id]}</p>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
