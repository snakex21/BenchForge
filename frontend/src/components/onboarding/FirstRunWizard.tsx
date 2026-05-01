import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ModelLogo, getProviderLogo } from '@/components/ui/ModelLogo'
import { useBenchmarkStore } from '@/store/benchmarkStore'
import { useModelStore } from '@/store/modelStore'
import { useUIStore } from '@/store/uiStore'
import { useTranslation } from '@/i18n'
import type { AIModel, ApiProvider } from '@/types'
import { PROVIDER_API_KEY_PLACEHOLDERS, PROVIDER_LABELS, PROVIDER_MODEL_PLACEHOLDERS, PROVIDER_OPTIONS, PROVIDER_PICKER_GROUPS, PROVIDER_PRESETS, PROVIDER_SCAN_OVERRIDES } from '@/features/models/providerConfig'

interface FirstRunWizardProps {
  onComplete: () => void
}

interface SavedProviderConfig {
  apiKey?: string
  baseUrl?: string
}

interface ScannedModel {
  provider: ApiProvider
  modelId: string
}

const ProviderLogo: React.FC<{ provider: ApiProvider; className?: string }> = ({ provider, className = '' }) => {
  const logo = getProviderLogo(provider)
  if (!logo) return <span className={`${className} inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700/50 bg-slate-950/40 text-xs`}>⚙️</span>
  return <span className={`${className} inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg border border-slate-700/50 bg-white/95 p-1`}><img src={logo} alt="" className="h-full w-full object-contain" /></span>
}

const scanKey = (model: ScannedModel) => `${model.provider}:${model.modelId}`

export const FirstRunWizard: React.FC<FirstRunWizardProps> = ({ onComplete }) => {
  const { t } = useTranslation()
  const models = useModelStore((state) => state.models)
  const loadModels = useModelStore((state) => state.loadFromDb)
  const addBenchmark = useBenchmarkStore((state) => state.addBenchmark)
  const addTask = useBenchmarkStore((state) => state.addTask)
  const loadBenchmarks = useBenchmarkStore((state) => state.loadFromDb)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const setRerunTarget = useUIStore((state) => state.setRerunTarget)

  const [step, setStep] = useState(0)
  const [provider, setProvider] = useState<ApiProvider>('lmstudio')
  const [modelName, setModelName] = useState(PROVIDER_LABELS.lmstudio)
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS.lmstudio)
  const [modelId, setModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [modelStatus, setModelStatus] = useState<string | null>(null)
  const [createdModelId, setCreatedModelId] = useState<number | null>(null)
  const [createdBenchmarkId, setCreatedBenchmarkId] = useState<number | null>(null)
  const [healthChecks, setHealthChecks] = useState<Array<Record<string, unknown> & { label?: string; ok?: boolean; required?: boolean; version?: string; error?: string | null }> | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [scannedModels, setScannedModels] = useState<ScannedModel[]>([])
  const [scanErrors, setScanErrors] = useState<Record<string, string>>({})

  const savedProviderConfigs = useMemo<Partial<Record<ApiProvider, SavedProviderConfig>>>(() => {
    const configs: Partial<Record<ApiProvider, SavedProviderConfig>> = {}
    const sortedModels = [...models].sort((left, right) => right.id - left.id)
    for (const model of sortedModels) {
      if (model.mode !== 'api' || !model.provider) continue
      const config = configs[model.provider] || {}
      const savedApiKey = model.api_key?.trim()
      const savedBaseUrl = model.base_url?.trim()
      if (!config.apiKey && savedApiKey) config.apiKey = savedApiKey
      if (!config.baseUrl && savedBaseUrl) config.baseUrl = savedBaseUrl
      configs[model.provider] = config
    }
    return configs
  }, [models])

  useEffect(() => {
    let cancelled = false
    const loadDiscovered = async () => {
      const cached = await window.db?.getDiscoveredModels?.()
      if (cancelled || !cached) return
      setScannedModels(cached
        .filter((model): model is { provider: ApiProvider; modelId: string } => Boolean(model.modelId) && PROVIDER_OPTIONS.some((item) => item.value === model.provider))
        .map((model) => ({ provider: model.provider, modelId: model.modelId })))
    }
    void loadDiscovered()
    return () => { cancelled = true }
  }, [])

  const getProviderDefaults = (nextProvider: ApiProvider) => ({
    baseUrl: savedProviderConfigs[nextProvider]?.baseUrl || PROVIDER_PRESETS[nextProvider],
    apiKey: savedProviderConfigs[nextProvider]?.apiKey || '',
  })

  const handleProviderChange = (nextProvider: ApiProvider) => {
    const defaults = getProviderDefaults(nextProvider)
    setProvider(nextProvider)
    setModelName(PROVIDER_LABELS[nextProvider])
    setBaseUrl(defaults.baseUrl)
    setApiKey(defaults.apiKey)
    setModelId('')
    setModelStatus(null)
  }

  const fillFromScannedModel = (model: ScannedModel) => {
    const defaults = getProviderDefaults(model.provider)
    setProvider(model.provider)
    setModelName(`${PROVIDER_LABELS[model.provider]} · ${model.modelId}`)
    setBaseUrl(defaults.baseUrl)
    setApiKey(defaults.apiKey)
    setModelId(model.modelId)
    setModelStatus(null)
  }

  const modelPayload = (): Omit<AIModel, 'id' | 'created_at'> => ({
    name: modelName.trim() || PROVIDER_LABELS[provider],
    mode: 'api',
    provider,
    base_url: baseUrl.trim(),
    api_key: apiKey.trim() || null,
    model_id: modelId.trim() || null,
  })

  const testModel = async () => {
    setIsBusy(true)
    setModelStatus(t('models.testingConnection'))
    try {
      const result = await window.db?.testConnection({ modelConfig: modelPayload() })
      setModelStatus(result?.ok ? t('models.connectionOk') : t('models.connectionError', { error: result?.error || '' }))
    } finally {
      setIsBusy(false)
    }
  }

  const scanModels = async (scanAll = false) => {
    if (!window.db) return
    setIsScanning(true)
    setScanErrors({})
    try {
      const endpoints = PROVIDER_OPTIONS
        .filter((item) => {
          const savedBaseUrl = savedProviderConfigs[item.value]?.baseUrl
          const selectedBaseUrl = item.value === provider ? baseUrl.trim() : ''
          const hasBaseUrl = Boolean(item.baseUrl || savedBaseUrl || selectedBaseUrl)
          return hasBaseUrl && (scanAll || item.value === provider || item.value === 'lmstudio' || item.value === 'ollama' || item.value === 'vllm')
        })
        .map((item) => {
          const override = PROVIDER_SCAN_OVERRIDES[item.value] || {}
          const savedConfig = savedProviderConfigs[item.value]
          const selectedProvider = item.value === provider
          const sourceBaseUrl = selectedProvider ? baseUrl.trim() || savedConfig?.baseUrl || item.baseUrl : savedConfig?.baseUrl || item.baseUrl
          const sourceApiKey = selectedProvider ? apiKey.trim() || savedConfig?.apiKey : savedConfig?.apiKey
          return {
            key: item.value,
            name: item.label,
            url: override.url || (item.value === 'ollama' ? sourceBaseUrl.replace(/\/v1$/i, '') : sourceBaseUrl),
            type: item.value === 'ollama' ? 'ollama' : 'openai',
            apiKey: sourceApiKey || undefined,
            scanPath: override.scanPath,
            authType: override.authType,
            scanUnsupported: override.scanUnsupported,
            requiresApiKey: override.requiresApiKey,
          }
        })
      const result = await window.db.scanModels({ endpoints })
      const found: ScannedModel[] = PROVIDER_OPTIONS.flatMap((item) => {
        const modelsForProvider = result[item.value]
        return Array.isArray(modelsForProvider) ? modelsForProvider.map((foundModelId) => ({ provider: item.value, modelId: String(foundModelId) })) : []
      })
      setScannedModels(found)
      setScanErrors(result.errors || {})
      if (found.length > 0) setModelStatus(t('models.connectionOkShort'))
    } catch (error) {
      setModelStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsScanning(false)
    }
  }

  const addPresetModel = async () => {
    setIsBusy(true)
    try {
      const created = await window.db?.addModel(modelPayload())
      await loadModels()
      if (created?.id) setCreatedModelId(created.id)
      setModelStatus(t('onboarding.modelAdded'))
      setStep(2)
    } finally {
      setIsBusy(false)
    }
  }

  const runHealth = async () => {
    setIsBusy(true)
    try {
      const result = await window.benchforge?.healthCheck?.()
      setHealthChecks(result?.checks || [])
    } finally {
      setIsBusy(false)
    }
  }

  const createStarterBenchmark = async () => {
    setIsBusy(true)
    try {
      const created = await addBenchmark({
        name: t('onboarding.benchmarkName'),
        category: 'Logika',
        suite_name: t('onboarding.benchmarkSuite'),
        description: t('onboarding.benchmarkDescription'),
        prompt_template: t('onboarding.benchmarkPrompt'),
        score_type: 'boolean',
        expected_answer: 'tak',
        pass_condition: t('onboarding.benchmarkPass'),
        evaluation_checklist: [t('onboarding.benchmarkChecklist')],
        evaluation_rubric: [],
        attempts: 1,
        output_type: 'text',
        reference_image: null,
        tasks: [],
      })
      if (created) {
        await addTask({
          benchmarkId: created.id,
          name: t('onboarding.taskName'),
          promptTemplate: t('onboarding.taskPrompt'),
          scoreType: 'boolean',
          expectedAnswer: 'tak',
          passCondition: t('onboarding.taskPass'),
          evaluationChecklist: [t('onboarding.taskChecklist')],
          attempts: 1,
          outputType: 'text',
          orderIndex: 0,
        })
        await loadBenchmarks()
        setCreatedBenchmarkId(created.id)
      }
      setStep(4)
    } finally {
      setIsBusy(false)
    }
  }

  const finish = async (goRun = false) => {
    await window.db?.savePreference('onboarding_completed', true)
    if (goRun && createdModelId && createdBenchmarkId) {
      setRerunTarget({ modelId: createdModelId, benchmarkId: createdBenchmarkId })
      setActiveView('runner')
    }
    onComplete()
  }

  const canAddModel = Boolean(baseUrl.trim() && modelId.trim())
  const visibleScanned = scannedModels.filter((model) => model.provider === provider)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 sm:p-6">
      <div className="max-h-[94vh] w-full max-w-5xl overflow-auto rounded-2xl border border-indigo-500/40 bg-[#161822] shadow-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-700/40 p-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-300">BenchForge</p>
            <h2 className="mt-1 text-xl font-bold text-slate-100">{t('onboarding.title')}</h2>
            <p className="mt-1 text-sm text-slate-500">{t('onboarding.subtitle')}</p>
          </div>
          <Button variant="ghost" onClick={() => void finish(false)}>{t('onboarding.skip')}</Button>
        </div>

        <div className="grid gap-4 p-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="space-y-2">
            {[t('onboarding.stepWelcome'), t('onboarding.stepModel'), t('onboarding.stepHealth'), t('onboarding.stepBenchmark'), t('onboarding.stepRun')].map((label, index) => <button key={label} type="button" onClick={() => setStep(index)} className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${step === index ? 'border-indigo-400 bg-indigo-500/10 text-slate-100' : 'border-slate-700/40 bg-slate-950/30 text-slate-400'}`}>{index + 1}. {label}</button>)}
          </aside>

          <section className="min-h-[420px] space-y-4">
            {step === 0 && <div className="space-y-4"><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.welcomeTitle')}</h3><p className="text-sm text-slate-400">{t('onboarding.welcomeBody')}</p><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-4"><p className="font-semibold text-slate-200">{t('onboarding.localLabel')}</p><p className="mt-1 text-sm text-slate-500">{t('onboarding.localDescription')}</p></div><div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-4"><p className="font-semibold text-slate-200">{t('onboarding.apiLabel')}</p><p className="mt-1 text-sm text-slate-500">{t('onboarding.apiDescription')}</p></div></div><Button onClick={() => setStep(1)}>{t('common.start')}</Button></div>}

            {step === 1 && <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.modelTitle')}</h3><p className="mt-1 text-sm text-slate-500">{t('models.newModelDescription')}</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" onClick={() => void scanModels(false)} disabled={isScanning}>{isScanning ? t('models.scanning') : t('models.scanModels')}</Button><Button variant="ghost" size="sm" onClick={() => void scanModels(true)} disabled={isScanning}>{isScanning ? t('models.scanning') : t('models.scanAll')}</Button></div></div>
              <div className="grid max-h-72 gap-2 overflow-auto rounded-xl border border-slate-700/40 bg-slate-950/20 p-2 sm:grid-cols-2 xl:grid-cols-3">
                {PROVIDER_PICKER_GROUPS.map((group) => <div key={group.label} className="space-y-1"><p className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{group.label}</p>{group.options.map((option) => <button key={option.value} type="button" onClick={() => handleProviderChange(option.value)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${provider === option.value ? 'bg-indigo-500/15 text-slate-100 ring-1 ring-indigo-500/30' : 'text-slate-300 hover:bg-slate-800'}`}><ProviderLogo provider={option.value} /><span className="min-w-0 flex-1"><span className="block truncate">{option.label}</span><span className="block truncate text-[11px] text-slate-500">{savedProviderConfigs[option.value]?.apiKey ? `🔑 ${t('models.savedKeyBadge')}` : option.baseUrl || 'custom'}</span></span></button>)}</div>)}
              </div>

              <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm text-slate-300">{t('common.name')}<input className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={modelName} onChange={(event) => setModelName(event.target.value)} /></label><label className="text-sm text-slate-300">{t('onboarding.modelIdLabel')}<input className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={PROVIDER_MODEL_PLACEHOLDERS[provider]} /></label></div>
              <label className="block text-sm text-slate-300">{t('onboarding.baseUrlLabel')}<input className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={PROVIDER_PRESETS[provider] || 'https://example.com/v1'} /></label>
              <label className="block text-sm text-slate-300">{t('models.apiKey')}<div className="mt-1 flex gap-2"><input type={showApiKey ? 'text' : 'password'} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={PROVIDER_API_KEY_PLACEHOLDERS[provider] || t('models.apiKeyNoSavedHint')} /><Button variant="ghost" onClick={() => setShowApiKey((visible) => !visible)}>{showApiKey ? t('models.hideApiKey') : t('models.showApiKey')}</Button></div></label>

              <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3">
                <div className="mb-2 flex items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('models.foundLocal')}</p><Badge variant="neutral">{visibleScanned.length}</Badge></div>
                {Object.entries(scanErrors).length > 0 && <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">{Object.entries(scanErrors).map(([scanProvider, error]) => <p key={scanProvider}>{scanProvider}: {error}</p>)}</div>}
                {visibleScanned.length === 0 ? <p className="text-xs text-slate-500">{t('models.noScanned')}</p> : <div className="grid max-h-44 gap-2 overflow-auto sm:grid-cols-2">{visibleScanned.map((scanned) => <button key={scanKey(scanned)} type="button" onClick={() => fillFromScannedModel(scanned)} className="flex items-center gap-2 rounded-lg border border-slate-700/40 bg-slate-950/40 px-2 py-2 text-left hover:border-indigo-400/50"><ModelLogo provider={scanned.provider} modelId={scanned.modelId} name={scanned.modelId} size="sm" /><span className="min-w-0"><span className="block truncate text-sm text-slate-200">{scanned.modelId}</span><span className="block text-xs text-slate-500">{PROVIDER_LABELS[scanned.provider]}</span></span></button>)}</div>}
              </div>

              <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void testModel()} disabled={isBusy || !baseUrl.trim() || !modelId.trim()}>{t('models.testConnection')}</Button><Button onClick={() => void addPresetModel()} disabled={isBusy || !canAddModel}>{t('onboarding.addModel')}</Button><Button variant="ghost" onClick={() => setStep(2)}>{t('onboarding.skipModel')}</Button></div>{modelStatus && <p className="text-sm text-slate-500">{modelStatus}</p>}
            </div>}

            {step === 2 && <div className="space-y-4"><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.healthTitle')}</h3><p className="text-sm text-slate-500">{t('onboarding.healthDescription')}</p><Button variant="secondary" onClick={() => void runHealth()} disabled={isBusy}>{t('settings.environmentCheck')}</Button>{healthChecks && <div className="grid gap-2 sm:grid-cols-2">{healthChecks.map((check, index) => <div key={index} className={`rounded-lg border p-3 text-xs ${check.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : check.required ? 'border-red-500/30 bg-red-500/10 text-red-100' : 'border-amber-500/30 bg-amber-500/10 text-amber-100'}`}><p className="font-semibold">{check.ok ? '✅' : check.required ? '❌' : '⚠️'} {String(check.label || '')}</p><p className="mt-1 opacity-80">{String(check.version || check.error || '')}</p></div>)}</div>}<div className="flex gap-2"><Button onClick={() => setStep(3)}>{t('common.next')}</Button></div></div>}

            {step === 3 && <div className="space-y-4"><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.benchmarkTitle')}</h3><p className="text-sm text-slate-500">{t('onboarding.benchmarkDescription')}</p><div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-4"><div className="flex items-center justify-between gap-3"><div><p className="font-semibold text-slate-200">{t('onboarding.benchmarkName')}</p><p className="text-sm text-slate-500">{t('onboarding.benchmarkSummary')}</p></div>{createdBenchmarkId ? <Badge variant="success">{t('common.done')}</Badge> : <Button onClick={() => void createStarterBenchmark()} disabled={isBusy}>{t('onboarding.createBenchmark')}</Button>}</div></div><Button variant="ghost" onClick={() => setStep(4)}>{t('common.next')}</Button></div>}

            {step === 4 && <div className="space-y-4"><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.runTitle')}</h3><p className="text-sm text-slate-500">{t('onboarding.runDescription')}</p><div className="flex flex-wrap gap-2"><Button onClick={() => void finish(true)} disabled={!createdModelId || !createdBenchmarkId}>{t('onboarding.openRunner')}</Button><Button variant="secondary" onClick={() => void finish(false)}>{t('onboarding.finish')}</Button></div>{(!createdModelId || !createdBenchmarkId) && <p className="text-xs text-amber-300">{t('onboarding.runNeedsData')}</p>}</div>}
          </section>
        </div>
      </div>
    </div>
  )
}
