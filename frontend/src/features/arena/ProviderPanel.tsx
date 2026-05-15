// ============================================================
// ProviderPanel — zarządzanie providerami (API key + modele)
// ============================================================

import React, { useEffect, useMemo, useState } from 'react'
import { useModelStore } from '@/store/modelStore'
import { useProviderConfigStore } from '@/store/providerConfigStore'
import { Button } from '@/components/ui/Button'
import { ModelLogo, getProviderLogo } from '@/components/ui/ModelLogo'
import { Badge } from '@/components/ui/Badge'
import type { AIModel, ApiProvider } from '@/types'
import { useTranslation } from '@/i18n'
import {
  PROVIDER_API_KEY_PLACEHOLDERS,
  PROVIDER_LABELS,
  PROVIDER_MODEL_PLACEHOLDERS,
  PROVIDER_PRESETS,
} from '@/features/models/providerConfig'

interface Props {
  provider: ApiProvider
  onClose: () => void
}

export const ProviderPanel: React.FC<Props> = ({ provider, onClose }) => {
  const { t } = useTranslation()
  const models = useModelStore((state) => state.models)
  const updateModel = useModelStore((state) => state.updateModel)
  const removeModel = useModelStore((state) => state.removeModel)
  const addModel = useModelStore((state) => state.addModel)

  const configs = useProviderConfigStore((state) => state.configs)
  const saveConfig = useProviderConfigStore((state) => state.saveConfig)
  const deleteConfig = useProviderConfigStore((state) => state.deleteConfig)

  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [testingModelId, setTestingModelId] = useState<number | null>(null)
  const [testStatuses, setTestStatuses] = useState<Record<number, string>>({})

  const providerModels = useMemo(
    () => models.filter((m) => m.mode === 'api' && m.provider === provider),
    [models, provider],
  )

  const currentConfig = useMemo(
    () => configs.find((c) => c.provider === provider),
    [configs, provider],
  )

  // Init form from saved config or preset
  useEffect(() => {
    setApiKey(currentConfig?.api_key || '')
    setBaseUrl(currentConfig?.base_url || PROVIDER_PRESETS[provider])
  }, [provider, currentConfig])

  const handleSaveConfig = async () => {
    const result = await saveConfig(provider, {
      api_key: apiKey.trim() || null,
      base_url: baseUrl.trim() || null,
    })
    setSaveMsg(result ? t('models.providerConfigSaved') : t('models.providerConfigSaveFailed'))
    setTimeout(() => setSaveMsg(null), 2500)
  }

  const handleDeleteConfig = async () => {
    await deleteConfig(provider)
    setApiKey('')
    setBaseUrl(PROVIDER_PRESETS[provider])
    setSaveMsg(t('models.providerConfigCleared'))
    setTimeout(() => setSaveMsg(null), 2500)
  }

  const handleToggleModel = async (model: AIModel) => {
    await updateModel(model.id, { active: !model.active } as Partial<Omit<AIModel, 'id' | 'created_at'>>)
  }

  const handleDeleteModel = async (model: AIModel) => {
    await removeModel(model.id)
  }

  const handleAddModel = async () => {
    const modelId = newModelId.trim()
    if (!modelId) return

    await addModel({
      name: `${PROVIDER_LABELS[provider]} · ${modelId}`,
      mode: 'api',
      provider,
      base_url: baseUrl.trim() || null,
      api_key: apiKey.trim() || null,
      model_id: modelId,
      active: true,
    })
    setNewModelId('')
  }

  const handleTestModel = async (modelId: number) => {
    if (!window.db) return
    setTestingModelId(modelId)
    setTestStatuses((s) => ({ ...s, [modelId]: t('models.testingConnection') }))

    const result = await window.db.testConnection({ modelId })
    setTestStatuses((s) => ({
      ...s,
      [modelId]: result.ok ? t('models.connectionOkShort') : t('models.errorShort', { error: result.error || '' }),
    }))
    setTestingModelId(null)
  }

  const providerLogo = getProviderLogo(provider)

  return (
    <div className="h-full overflow-auto">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {providerLogo ? (
              <span className="inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg border border-slate-700/50 bg-white/95 p-1">
                <img src={providerLogo} alt="" className="h-full w-full object-contain" />
              </span>
            ) : (
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700/50 bg-slate-950/40 text-sm">⚙️</span>
            )}
            <h2 className="text-lg font-semibold text-slate-100">{PROVIDER_LABELS[provider]}</h2>
          </div>
          <Badge variant="neutral">{providerModels.length} {t('models.modelsCount')}</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</Button>
      </div>

      {/* API Key */}
      <div className="mb-4 rounded-xl border border-slate-700/40 bg-slate-950/30 p-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">{t('models.apiKey')}</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={PROVIDER_API_KEY_PLACEHOLDERS[provider]}
              className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 pr-20 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            >
              {showKey ? t('models.hideApiKey') : t('models.showApiKey')}
            </button>
          </div>
          {currentConfig?.api_key && apiKey === currentConfig.api_key && (
            <p className="mt-1 text-xs text-emerald-400">🔑 {t('models.apiKeySaved')}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">{t('models.baseUrlLabel')}</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={PROVIDER_PRESETS[provider]}
            className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSaveConfig}>
            {t('models.saveProviderConfig')}
          </Button>
          {currentConfig && (
            <Button size="sm" variant="ghost" onClick={handleDeleteConfig}>
              {t('models.clearProviderConfig')}
            </Button>
          )}
          {saveMsg && <p className="text-xs text-emerald-400">{saveMsg}</p>}
        </div>
      </div>

      {/* Models for this provider */}
      <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-200">{t('models.providerModels')}</h3>
          <span className="text-xs text-slate-500">
            {providerModels.filter((m) => m.active).length}/{providerModels.length} {t('models.activeModels')}
          </span>
        </div>

        {providerModels.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">{t('models.noProviderModels')}</p>
        ) : (
          <div className="space-y-2">
            {providerModels.map((model) => (
              <div
                key={model.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition ${
                  model.active
                    ? 'border-slate-700/40 bg-[#0f1117]'
                    : 'border-slate-800/30 bg-slate-950/20 opacity-60'
                }`}
              >
                <label className="flex cursor-pointer items-center gap-2 shrink-0">
                  <input
                    type="checkbox"
                    checked={model.active}
                    onChange={() => void handleToggleModel(model)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-indigo-500 cursor-pointer"
                  />
                </label>

                <ModelLogo model={model} size="sm" />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-200">{model.model_id || model.name}</p>
                  {!model.active && (
                    <p className="text-[11px] text-slate-600">{t('models.modelDisabled')}</p>
                  )}
                </div>

                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleTestModel(model.id)}
                    disabled={testingModelId === model.id}
                  >
                    {t('models.test')}
                  </Button>
                  <button
                    onClick={() => void handleDeleteModel(model)}
                    className="p-1.5 text-slate-600 transition-colors hover:text-red-400"
                    title={t('models.deleteModel')}
                  >
                    ✕
                  </button>
                </div>

                {testStatuses[model.id] && (
                  <p className="shrink-0 text-xs text-slate-500">{testStatuses[model.id]}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add model */}
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            placeholder={PROVIDER_MODEL_PLACEHOLDERS[provider]}
            className="h-10 flex-1 rounded-xl border border-slate-600/50 bg-[#0f1117] px-3 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAddModel() } }}
          />
          <Button size="sm" onClick={() => void handleAddModel()} disabled={!newModelId.trim()}>
            {t('models.addProviderModel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
