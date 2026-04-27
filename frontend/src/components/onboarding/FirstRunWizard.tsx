import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useBenchmarkStore } from '@/store/benchmarkStore'
import { useModelStore } from '@/store/modelStore'
import { useUIStore } from '@/store/uiStore'
import { useTranslation } from '@/i18n'
import type { AIModel, ApiProvider } from '@/types'

type PresetId = 'lmstudio' | 'ollama' | 'openai-compatible' | 'deepseek' | 'openrouter'

interface ModelPreset {
  id: PresetId
  provider: ApiProvider
  label: string
  description: string
  baseUrl: string
  modelId: string
  apiKeyPlaceholder: string
}

const MODEL_PRESETS: ModelPreset[] = [
  { id: 'lmstudio', provider: 'lmstudio', label: 'LMStudio', description: 'Local OpenAI-compatible server on port 1234.', baseUrl: 'http://localhost:1234/v1', modelId: 'local-model', apiKeyPlaceholder: '' },
  { id: 'ollama', provider: 'ollama', label: 'Ollama', description: 'Local Ollama OpenAI-compatible endpoint.', baseUrl: 'http://localhost:11434/v1', modelId: 'llama3.1', apiKeyPlaceholder: '' },
  { id: 'openai-compatible', provider: 'openai-compatible', label: 'OpenAI-compatible', description: 'Any compatible API endpoint.', baseUrl: 'https://example.com/v1', modelId: 'model-name', apiKeyPlaceholder: 'sk-...' },
  { id: 'deepseek', provider: 'deepseek', label: 'DeepSeek', description: 'DeepSeek API preset.', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat', apiKeyPlaceholder: 'sk-...' },
  { id: 'openrouter', provider: 'openrouter', label: 'OpenRouter', description: 'OpenRouter gateway preset.', baseUrl: 'https://openrouter.ai/api/v1', modelId: 'qwen/qwen3.6-35b-a3b', apiKeyPlaceholder: 'sk-or-...' },
]

interface FirstRunWizardProps {
  onComplete: () => void
}

const remoteProviders = new Set<ApiProvider>(['openai-compatible', 'deepseek', 'openrouter'])

export const FirstRunWizard: React.FC<FirstRunWizardProps> = ({ onComplete }) => {
  const { t } = useTranslation()
  const loadModels = useModelStore((state) => state.loadFromDb)
  const addBenchmark = useBenchmarkStore((state) => state.addBenchmark)
  const addTask = useBenchmarkStore((state) => state.addTask)
  const loadBenchmarks = useBenchmarkStore((state) => state.loadFromDb)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const setRerunTarget = useUIStore((state) => state.setRerunTarget)

  const [step, setStep] = useState(0)
  const [presetId, setPresetId] = useState<PresetId>('lmstudio')
  const selectedPreset = useMemo(() => MODEL_PRESETS.find((preset) => preset.id === presetId) || MODEL_PRESETS[0], [presetId])
  const [modelName, setModelName] = useState(selectedPreset.label)
  const [baseUrl, setBaseUrl] = useState(selectedPreset.baseUrl)
  const [modelId, setModelId] = useState(selectedPreset.modelId)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [modelStatus, setModelStatus] = useState<string | null>(null)
  const [createdModelId, setCreatedModelId] = useState<number | null>(null)
  const [createdBenchmarkId, setCreatedBenchmarkId] = useState<number | null>(null)
  const [healthChecks, setHealthChecks] = useState<Array<Record<string, unknown> & { label?: string; ok?: boolean; required?: boolean; version?: string; error?: string | null }> | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  useEffect(() => {
    setModelName(selectedPreset.label)
    setBaseUrl(selectedPreset.baseUrl)
    setModelId(selectedPreset.modelId)
    setApiKey('')
    setModelStatus(null)
  }, [selectedPreset])

  const modelPayload = (): Omit<AIModel, 'id' | 'created_at'> => ({
    name: modelName.trim() || selectedPreset.label,
    mode: 'api',
    provider: selectedPreset.provider,
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
        name: 'BenchForge Quick Start QA',
        category: 'Logika',
        suite_name: 'BenchForge Onboarding',
        description: 'Tiny starter benchmark created by the first-run wizard.',
        prompt_template: 'Starter benchmark with one simple task.',
        score_type: 'boolean',
        expected_answer: 'tak',
        pass_condition: 'Odpowiedź powinna brzmieć TAK.',
        evaluation_checklist: ['Czy model odpowiedział TAK?'],
        evaluation_rubric: [],
        attempts: 1,
        output_type: 'text',
        reference_image: null,
        tasks: [],
      })
      if (created) {
        await addTask({
          benchmarkId: created.id,
          name: 'Say TAK',
          promptTemplate: 'Odpowiedz dokładnie jednym słowem: TAK',
          scoreType: 'boolean',
          expectedAnswer: 'tak',
          passCondition: 'Odpowiedź powinna zawierać TAK.',
          evaluationChecklist: ['Czy odpowiedź zawiera TAK?'],
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

  const canAddModel = Boolean(baseUrl.trim() && modelId.trim()) && (!remoteProviders.has(selectedPreset.provider) || Boolean(apiKey.trim()))

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 sm:p-6">
      <div className="max-h-[94vh] w-full max-w-4xl overflow-auto rounded-2xl border border-indigo-500/40 bg-[#161822] shadow-2xl">
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
            {step === 0 && <div className="space-y-4"><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.welcomeTitle')}</h3><p className="text-sm text-slate-400">{t('onboarding.welcomeBody')}</p><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-4"><p className="font-semibold text-slate-200">Local</p><p className="mt-1 text-sm text-slate-500">LMStudio / Ollama</p></div><div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-4"><p className="font-semibold text-slate-200">API</p><p className="mt-1 text-sm text-slate-500">DeepSeek / OpenRouter / OpenAI-compatible</p></div></div><Button onClick={() => setStep(1)}>{t('common.start')}</Button></div>}

            {step === 1 && <div className="space-y-4"><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.modelTitle')}</h3><div className="grid gap-2 sm:grid-cols-2">{MODEL_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => setPresetId(preset.id)} className={`rounded-xl border p-3 text-left ${presetId === preset.id ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-700/40 bg-slate-950/30'}`}><p className="text-sm font-semibold text-slate-200">{preset.label}</p><p className="mt-1 text-xs text-slate-500">{preset.description}</p></button>)}</div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm text-slate-300">{t('common.name')}<input className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={modelName} onChange={(event) => setModelName(event.target.value)} /></label><label className="text-sm text-slate-300">Model ID<input className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={modelId} onChange={(event) => setModelId(event.target.value)} /></label></div><label className="block text-sm text-slate-300">Base URL<input className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label><label className="block text-sm text-slate-300">API Key<div className="mt-1 flex gap-2"><input type={showApiKey ? 'text' : 'password'} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selectedPreset.apiKeyPlaceholder || t('models.apiKeyNoSavedHint')} /><Button variant="ghost" onClick={() => setShowApiKey((visible) => !visible)}>{showApiKey ? t('models.hideApiKey') : t('models.showApiKey')}</Button></div></label><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void testModel()} disabled={isBusy || !baseUrl.trim() || !modelId.trim()}>{t('models.testConnection')}</Button><Button onClick={() => void addPresetModel()} disabled={isBusy || !canAddModel}>{t('onboarding.addModel')}</Button><Button variant="ghost" onClick={() => setStep(2)}>{t('onboarding.skipModel')}</Button></div>{modelStatus && <p className="text-sm text-slate-500">{modelStatus}</p>}</div>}

            {step === 2 && <div className="space-y-4"><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.healthTitle')}</h3><p className="text-sm text-slate-500">{t('onboarding.healthDescription')}</p><Button variant="secondary" onClick={() => void runHealth()} disabled={isBusy}>{t('settings.environmentCheck')}</Button>{healthChecks && <div className="grid gap-2 sm:grid-cols-2">{healthChecks.map((check, index) => <div key={index} className={`rounded-lg border p-3 text-xs ${check.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : check.required ? 'border-red-500/30 bg-red-500/10 text-red-100' : 'border-amber-500/30 bg-amber-500/10 text-amber-100'}`}><p className="font-semibold">{check.ok ? '✅' : check.required ? '❌' : '⚠️'} {String(check.label || '')}</p><p className="mt-1 opacity-80">{String(check.version || check.error || '')}</p></div>)}</div>}<div className="flex gap-2"><Button onClick={() => setStep(3)}>{t('common.next')}</Button></div></div>}

            {step === 3 && <div className="space-y-4"><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.benchmarkTitle')}</h3><p className="text-sm text-slate-500">{t('onboarding.benchmarkDescription')}</p><div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-4"><div className="flex items-center justify-between gap-3"><div><p className="font-semibold text-slate-200">BenchForge Quick Start QA</p><p className="text-sm text-slate-500">1 task · boolean · TAK/NIE</p></div>{createdBenchmarkId ? <Badge variant="success">{t('common.done')}</Badge> : <Button onClick={() => void createStarterBenchmark()} disabled={isBusy}>{t('onboarding.createBenchmark')}</Button>}</div></div><Button variant="ghost" onClick={() => setStep(4)}>{t('common.next')}</Button></div>}

            {step === 4 && <div className="space-y-4"><h3 className="text-lg font-semibold text-slate-100">{t('onboarding.runTitle')}</h3><p className="text-sm text-slate-500">{t('onboarding.runDescription')}</p><div className="flex flex-wrap gap-2"><Button onClick={() => void finish(true)} disabled={!createdModelId || !createdBenchmarkId}>{t('onboarding.openRunner')}</Button><Button variant="secondary" onClick={() => void finish(false)}>{t('onboarding.finish')}</Button></div>{(!createdModelId || !createdBenchmarkId) && <p className="text-xs text-amber-300">{t('onboarding.runNeedsData')}</p>}</div>}
          </section>
        </div>
      </div>
    </div>
  )
}
