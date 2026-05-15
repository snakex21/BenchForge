// ============================================================
// ModelsView — lista i zarządzanie modelami AI
// ============================================================

import React, { useEffect, useMemo, useState } from 'react'
import { useModelStore } from '@/store/modelStore'
import { useUIStore } from '@/store/uiStore'
import { useProviderConfigStore } from '@/store/providerConfigStore'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { ModelLogo } from '@/components/ui/ModelLogo'
import type { AIModel, ApiProvider, ModelMode } from '@/types'
import { useTranslation } from '@/i18n'
import { PROVIDER_API_KEY_PLACEHOLDERS, PROVIDER_LABELS, PROVIDER_MODEL_PLACEHOLDERS, PROVIDER_OPTIONS, PROVIDER_PRESETS, PROVIDER_SCAN_OVERRIDES } from '@/features/models/providerConfig'
import { ProviderModelPicker } from '@/features/arena/ProviderModelPicker'

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
  provider: 'lmstudio' as string,
  base_url: PROVIDER_PRESETS.lmstudio,
  api_key: '',
  model_id: '',
  input_price_per_1m: '',
  output_price_per_1m: '',
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

type FormState = typeof defaultFormState

interface ScannedModel {
  provider: ApiProvider
  modelId: string
}

export const ModelsView: React.FC = () => {
  const models = useModelStore((state) => state.models)
  const addModel = useModelStore((state) => state.addModel)
  const updateModel = useModelStore((state) => state.updateModel)
  const removeModel = useModelStore((state) => state.removeModel)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const { t } = useTranslation()

  const [showForm, setShowForm] = useState(false)
  const [editingModelId, setEditingModelId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(defaultFormState)
  const [testingModelId, setTestingModelId] = useState<number | null>(null)
  const [cardTestStatuses, setCardTestStatuses] = useState<Record<number, string>>({})
  const [isScanning, setIsScanning] = useState(false)
  const [scanModalOpen, setScanModalOpen] = useState(false)
  const [scannedModels, setScannedModels] = useState<ScannedModel[]>([])
  const [selectedScanned, setSelectedScanned] = useState<string[]>([])
  const [scanErrors, setScanErrors] = useState<Record<string, string>>({})
  const [showDraftApiKey, setShowDraftApiKey] = useState(false)
  const [visibleApiKeys, setVisibleApiKeys] = useState<Record<number, boolean>>({})
  const [keyActionStatuses, setKeyActionStatuses] = useState<Record<number, string>>({})
  const [pricingStatus, setPricingStatus] = useState<string | null>(null)
  const [isRefreshingPricing, setIsRefreshingPricing] = useState(false)

  const loadProviderConfigs = useProviderConfigStore((state) => state.loadFromDb)

  const isApiMode = form.mode === 'api'
  const isLocalProvider = isApiMode && LOCAL_PROVIDERS.has(form.provider as ApiProvider)

  const savedProviderConfigs = useMemo<Partial<Record<string, SavedProviderConfig>>>(() => {
    const configs: Partial<Record<string, SavedProviderConfig>> = {}
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

  const getProviderDefaults = (provider: string) => ({
    baseUrl: savedProviderConfigs[provider]?.baseUrl || (PROVIDER_PRESETS as Record<string, string>)[provider] || '',
    apiKey: savedProviderConfigs[provider]?.apiKey || '',
  })

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
    void loadProviderConfigs()
    return () => { cancelled = true }
  }, [loadProviderConfigs])

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

  const openModelForm = () => {
    setEditingModelId(null)
    setShowDraftApiKey(false)
    setShowForm(true)
  }

  const openEditForm = (model: AIModel) => {
    setEditingModelId(model.id)
    setForm({
      name: model.name,
      mode: model.mode,
      provider: model.provider || 'lmstudio',
      base_url: model.base_url || '',
      api_key: model.api_key || '',
      model_id: model.model_id || '',
      input_price_per_1m: model.input_price_per_1m != null ? String(model.input_price_per_1m) : '',
      output_price_per_1m: model.output_price_per_1m != null ? String(model.output_price_per_1m) : '',
    })
    setShowDraftApiKey(false)
    setShowForm(true)
  }

  const closeModelForm = () => {
    setShowForm(false)
    setEditingModelId(null)
    setForm(defaultFormState)
    setShowDraftApiKey(false)
  }

  const scanKey = (model: ScannedModel) => `${model.provider}:${model.modelId}`

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
  }

  const handleScanModels = async (scanAll = false, scanProvider?: string, scanApiKey?: string, scanBaseUrl?: string) => {
    if (!window.db) return
    setIsScanning(true)
    setScanErrors({})
    const effectiveProvider = scanProvider || form.provider
    const effectiveApiKey = scanApiKey ?? form.api_key
    const effectiveBaseUrl = scanBaseUrl ?? form.base_url
    try {
      const endpoints = PROVIDER_OPTIONS
        .filter((provider) => {
          const savedBaseUrl = savedProviderConfigs[provider.value]?.baseUrl
          const selectedBaseUrl = provider.value === effectiveProvider ? (effectiveBaseUrl || '').trim() : ''
          const hasBaseUrl = Boolean(provider.baseUrl || savedBaseUrl || selectedBaseUrl)
          return hasBaseUrl && (scanAll || provider.value === effectiveProvider || provider.value === 'lmstudio' || provider.value === 'ollama' || provider.value === 'vllm')
        })
        .map((provider) => {
          const override = PROVIDER_SCAN_OVERRIDES[provider.value] || {}
          const savedConfig = savedProviderConfigs[provider.value]
          const selectedProvider = provider.value === effectiveProvider
          const sourceBaseUrl = selectedProvider ? (effectiveBaseUrl || '').trim() || savedConfig?.baseUrl || provider.baseUrl : savedConfig?.baseUrl || provider.baseUrl
          const sourceApiKey = selectedProvider ? (effectiveApiKey || '').trim() || savedConfig?.apiKey : savedConfig?.apiKey
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
        active: true,
      })
    }
    setScanModalOpen(false)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return

    const payload: Omit<AIModel, 'id' | 'created_at' | 'active'> = {
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

    if (editingModelId !== null) {
      await updateModel(editingModelId, payload)
    } else {
      await addModel({ ...payload, active: true })
    }

    setForm(defaultFormState)
    setEditingModelId(null)
    setShowForm(false)
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
      {/* Header */}
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
              {showForm ? t('common.cancel') : t('models.addProviderModels')}
            </Button>
          </div>
        )}
      </div>
      {pricingStatus && <div className="rounded-lg border border-slate-700/40 bg-slate-950/30 p-3 text-sm text-slate-400">{pricingStatus}</div>}

      {/* Gablota — model cards */}
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
          {models.filter(m => m.active).map((model) => (
            <Card key={model.id} padding>
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <ModelLogo model={model} size="lg" />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-slate-200">{model.name}</h3>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Badge variant={MODE_BADGE_VARIANTS[model.mode]}>{MODE_LABELS[model.mode]}</Badge>
                      {model.provider && <Badge variant="neutral">{(PROVIDER_LABELS as Record<string, string>)[model.provider] || model.provider}</Badge>}
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
                  <div className="flex shrink-0 gap-0.5">
                    <button
                      onClick={() => openEditForm(model)}
                      className="p-1 text-slate-600 transition-colors hover:text-indigo-400"
                      title={t('models.editModel')}
                    >
                      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793zM4.5 18.5H3v-1.5l7.293-7.293 2.828 2.828L5.828 18.5H4.5z"/>
                      </svg>
                    </button>
                    <button
                      onClick={() => void removeModel(model.id)}
                      className="p-1 text-slate-600 transition-colors hover:text-red-400"
                      title={t('models.deleteModel')}
                    >
                      ✕
                    </button>
                  </div>
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

      {/* Scan modal */}
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

      {/* Provider model picker popup (replaces old form modal) */}
      {showForm && (
        <ProviderModelPicker
          models={models}
          scannedModels={scannedModels}
          savedProviderConfigs={savedProviderConfigs}
          onClose={closeModelForm}
          onAddModels={async (provider, selectedModelIds, apiKey, baseUrl, visibleModelIds) => {
            const isCustom = provider.startsWith('custom:')
            const defaults = !isCustom ? getProviderDefaults(provider as ApiProvider) : { baseUrl: '', apiKey: '' }
            const label = isCustom
              ? (useProviderConfigStore.getState().configs.find(c => c.provider === provider)?.display_name || provider.replace('custom:', ''))
              : PROVIDER_LABELS[provider as ApiProvider]
            const selectedSet = new Set(selectedModelIds)
            const visibleSet = new Set(visibleModelIds)
            const existingForProvider = models.filter((model) => model.provider === provider && model.model_id)

            for (const model of existingForProvider) {
              const modelId = model.model_id || ''
              if (!visibleSet.has(modelId)) continue
              const shouldBeActive = selectedSet.has(modelId)
              if (model.active !== shouldBeActive) {
                await updateModel(model.id, { active: shouldBeActive })
              }
            }

            for (const modelId of selectedModelIds) {
              const alreadyExists = existingForProvider.some((model) => model.model_id === modelId)
              if (alreadyExists) continue
              await addModel({
                name: `${label} · ${modelId}`,
                mode: 'api',
                provider,
                base_url: baseUrl || defaults.baseUrl,
                api_key: apiKey || defaults.apiKey || null,
                model_id: modelId,
                active: true,
              } as any)
            }
            closeModelForm()
          }}
          onScan={(scanAll, provider, apiKey, baseUrl) => void handleScanModels(scanAll, provider, apiKey, baseUrl)}
          isScanning={isScanning}
        />
      )}

      {/* Edit model modal */}
      {editingModelId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={closeModelForm}>
          <div className="max-h-[92vh] w-full max-w-lg overflow-auto rounded-2xl border border-slate-700/60 bg-[#161822] shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-slate-700/40 p-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">{t('models.editModel')}</h3>
                <p className="mt-1 text-sm text-slate-500">{t('models.editModelDescription')}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={closeModelForm}>{t('common.close')}</Button>
            </div>
            <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4 p-5">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.modelName')}</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => updateForm('name', event.target.value)}
                  placeholder={t('models.modelNamePlaceholder')}
                  className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              {form.mode === 'api' && (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.apiKey')}</label>
                    <div className="relative">
                      <input
                        type={showDraftApiKey ? 'text' : 'password'}
                        value={form.api_key}
                        onChange={(event) => updateForm('api_key', event.target.value)}
                        placeholder={(PROVIDER_API_KEY_PLACEHOLDERS as Record<string, string>)[form.provider] || ''}
                        className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 pr-20 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                      />
                      <button type="button" onClick={() => setShowDraftApiKey((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100">
                        {showDraftApiKey ? t('models.hideApiKey') : t('models.showApiKey')}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.baseUrlLabel')}</label>
                    <input
                      type="text"
                      value={form.base_url}
                      onChange={(event) => updateForm('base_url', event.target.value)}
                      placeholder={(PROVIDER_PRESETS as Record<string, string>)[form.provider] || ''}
                      className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.modelIdLabel')}</label>
                    <input
                      type="text"
                      value={form.model_id}
                      onChange={(event) => updateForm('model_id', event.target.value)}
                      placeholder={(PROVIDER_MODEL_PLACEHOLDERS as Record<string, string>)[form.provider] || ''}
                      className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  </div>
                </>
              )}

              <div className="flex justify-end gap-2 border-t border-slate-700/40 pt-4">
                <Button type="button" variant="ghost" onClick={closeModelForm}>{t('common.cancel')}</Button>
                <Button type="submit" disabled={!canSubmit}>{t('models.saveModel')}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
