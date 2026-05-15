// ============================================================
// ProviderModelPicker — popup do wybierania modeli providera
// z przełącznikami (toggle), select all / clear all
// + custom provider creation
// ============================================================

import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { ModelLogo, getProviderLogo } from '@/components/ui/ModelLogo'
import type { AIModel, ApiProvider } from '@/types'
import { useProviderConfigStore } from '@/store/providerConfigStore'
import { useTranslation } from '@/i18n'
import {
  PROVIDER_API_KEY_PLACEHOLDERS,
  PROVIDER_LABELS,
  PROVIDER_PRESETS,
  PROVIDER_PICKER_GROUPS,
} from '@/features/models/providerConfig'

interface ScannedModel {
  provider: ApiProvider
  modelId: string
}

interface SavedProviderConfig {
  apiKey?: string
  baseUrl?: string
}

interface Props {
  models: AIModel[]
  scannedModels: ScannedModel[]
  savedProviderConfigs: Partial<Record<ApiProvider, SavedProviderConfig>>
  onClose: () => void
  onAddModels: (provider: string, selectedModelIds: string[], apiKey: string, baseUrl: string, visibleModelIds: string[]) => Promise<void>
  onScan: (scanAll: boolean, provider?: string, apiKey?: string, baseUrl?: string) => void
  isScanning: boolean
}

const ChevronIcon: React.FC<React.SVGProps<SVGSVGElement>> = ({ className = '', ...props }) => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M5.75 7.5 10 11.75 14.25 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ProviderLogo: React.FC<{ provider: string; iconUrl?: string | null; className?: string }> = ({ provider, iconUrl, className = '' }) => {
  if (iconUrl) {
    return <span className={`${className} inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg border border-slate-700/50 bg-white/95 p-1`}><img src={iconUrl} alt="" className="h-full w-full object-contain" /></span>
  }
  const logo = getProviderLogo(provider as ApiProvider)
  if (!logo) return <span className={`${className} inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700/50 bg-slate-950/40 text-xs`}>⚙️</span>
  return <span className={`${className} inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg border border-slate-700/50 bg-white/95 p-1`}><img src={logo} alt="" className="h-full w-full object-contain" /></span>
}

export const ProviderModelPicker: React.FC<Props> = ({
  models,
  scannedModels,
  savedProviderConfigs,
  onClose,
  onAddModels,
  onScan,
  isScanning,
}) => {
  const { t } = useTranslation()
  const providerConfigs = useProviderConfigStore((state) => state.configs)
  const saveConfig = useProviderConfigStore((state) => state.saveConfig)

  const [provider, setProvider] = useState('lmstudio')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isAdding, setIsAdding] = useState(false)

  // Custom provider creation state
  const [showCustomForm, setShowCustomForm] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customIcon, setCustomIcon] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customApiKey, setCustomApiKey] = useState('')
  const [customShowKey, setCustomShowKey] = useState(false)

  const customProviders = useMemo(() => {
    return providerConfigs.filter((c) => c.is_custom)
  }, [providerConfigs])

  const currentCustomConfig = useMemo(() => {
    if (!provider.startsWith('custom:')) return null
    return customProviders.find((c) => c.provider === provider) || null
  }, [provider, customProviders])

  const isBuiltIn = !provider.startsWith('custom:')

  const existingProviderModels = useMemo(() => {
    return models.filter((m) => m.mode === 'api' && m.provider === provider && m.model_id)
  }, [models, provider])

  const providerModels = useMemo(() => {
    const ids = new Set<string>()
    for (const model of existingProviderModels) {
      if (model.model_id) ids.add(model.model_id)
    }
    if (isBuiltIn) {
      for (const scanned of scannedModels.filter((m) => m.provider === provider)) {
        ids.add(scanned.modelId)
      }
    }
    return [...ids].sort((a, b) => a.localeCompare(b))
  }, [existingProviderModels, scannedModels, provider, isBuiltIn])

  const existingModelById = useMemo(() => {
    const map = new Map<string, AIModel>()
    for (const model of existingProviderModels) {
      if (model.model_id) map.set(model.model_id, model)
    }
    return map
  }, [existingProviderModels])

  const savedConfig = isBuiltIn ? savedProviderConfigs[provider as ApiProvider] : undefined
  const hasSavedKey = Boolean(savedConfig?.apiKey || currentCustomConfig?.api_key)

  useEffect(() => {
    const activeIds = existingProviderModels
      .filter((model) => model.active && model.model_id)
      .map((model) => model.model_id as string)
    setSelectedIds(new Set(activeIds))
  }, [provider])

  const getProviderLabel = (p: string) => {
    if (p.startsWith('custom:')) {
      const cfg = customProviders.find((c) => c.provider === p)
      return cfg?.display_name || p.replace('custom:', '')
    }
    return PROVIDER_LABELS[p as ApiProvider] || p
  }

  const getProviderPreset = (p: string) => {
    if (p.startsWith('custom:')) {
      const cfg = customProviders.find((c) => c.provider === p)
      return cfg?.base_url || ''
    }
    return PROVIDER_PRESETS[p as ApiProvider] || ''
  }

  const getHostname = (url?: string | null) => {
    if (!url) return ''
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  }

  const handleProviderChange = (p: string) => {
    setProvider(p)
    setShowCustomForm(false)

    if (p.startsWith('custom:')) {
      const cfg = customProviders.find((c) => c.provider === p)
      setApiKey(cfg?.api_key || '')
      setBaseUrl(cfg?.base_url || '')
    } else {
      const saved = savedProviderConfigs[p as ApiProvider]
      setApiKey(saved?.apiKey || '')
      setBaseUrl(saved?.baseUrl || PROVIDER_PRESETS[p as ApiProvider])
    }
    setSelectedIds(new Set())
    setProviderPickerOpen(false)
  }

  const handleCreateCustom = async () => {
    if (!customName.trim() || !customBaseUrl.trim()) return

    const providerId = `custom:${customName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`
    await saveConfig(providerId, {
      api_key: customApiKey.trim() || null,
      base_url: customBaseUrl.trim(),
      display_name: customName.trim(),
      icon_url: customIcon.trim() || null,
      is_custom: true,
    })

    // Switch to the new provider
    setProvider(providerId)
    setApiKey(customApiKey.trim())
    setBaseUrl(customBaseUrl.trim())
    setShowCustomForm(false)
    setCustomName('')
    setCustomIcon('')
    setCustomBaseUrl('')
    setCustomApiKey('')
    setSelectedIds(new Set())
  }

  const toggleModel = (modelId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(modelId)) next.delete(modelId)
      else next.add(modelId)
      return next
    })
  }

  const selectAll = () => setSelectedIds(new Set(providerModels))
  const clearAll = () => setSelectedIds(new Set())

  const handleAdd = async () => {
    const visibleModelIds = [...new Set([...providerModels, ...selectedIds])]
    if (selectedIds.size === 0 && visibleModelIds.length === 0) return
    setIsAdding(true)
    const effectiveProvider = isBuiltIn ? provider : provider
    await onAddModels(effectiveProvider, [...selectedIds], apiKey, baseUrl, visibleModelIds)
    setIsAdding(false)
  }

  const canApply = selectedIds.size > 0 || providerModels.length > 0

  const useSavedKey = () => {
    const key = savedConfig?.apiKey || currentCustomConfig?.api_key
    if (key) setApiKey(key)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-2xl border border-slate-700/60 bg-[#161822] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-700/40 p-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">
              {showCustomForm ? t('models.newCustomProvider') : t('models.addProviderModels')}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              {showCustomForm ? t('models.newCustomProviderDesc') : t('models.addProviderModelsDesc')}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {!showCustomForm && (
              <Button variant="secondary" size="sm" onClick={() => onScan(false, provider, apiKey, baseUrl)} disabled={isScanning}>
                {isScanning ? t('models.scanning') : t('models.scanModels')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => showCustomForm ? setShowCustomForm(false) : onClose()}>
              {t('common.close')}
            </Button>
          </div>
        </div>

        {showCustomForm ? (
          /* Custom provider creation form */
          <div className="space-y-4 p-5">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.customProviderName')}</label>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={t('models.customProviderNamePlaceholder')}
                className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.customProviderIcon')}</label>
              <div className="flex items-center gap-3">
                {/* Icon preview */}
                {customIcon.trim().startsWith('data:') ? (
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-600/50 bg-white/95 p-1">
                    <img src={customIcon.trim()} alt="" className="h-full w-full object-contain" />
                  </span>
                ) : (
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-600/50 bg-[#0f1117] text-xl">
                    {customIcon.trim() || '⚙️'}
                  </span>
                )}
                {/* Emoji / URL input */}
                <input
                  type="text"
                  value={customIcon.startsWith('data:') ? '' : customIcon}
                  onChange={(e) => setCustomIcon(e.target.value)}
                  placeholder="🤖 lub URL obrazka"
                  disabled={customIcon.startsWith('data:')}
                  className="h-11 flex-1 rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
                />
                {/* File upload button */}
                <label className="inline-flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-slate-600/50 bg-[#0f1117] px-3 text-xs text-slate-300 transition hover:bg-slate-800 hover:text-slate-100">
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 12v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3M12 7l-2-2-2 2M10 5v9"/>
                  </svg>
                  {t('models.uploadIcon')}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      const reader = new FileReader()
                      reader.onload = () => {
                        const img = new Image()
                        img.onload = () => {
                          // Resize to max 128x128
                          const maxSize = 128
                          let { width, height } = img
                          if (width > maxSize || height > maxSize) {
                            const ratio = Math.min(maxSize / width, maxSize / height)
                            width = Math.round(width * ratio)
                            height = Math.round(height * ratio)
                          }
                          const canvas = document.createElement('canvas')
                          canvas.width = width
                          canvas.height = height
                          const ctx = canvas.getContext('2d')
                          if (ctx) {
                            ctx.drawImage(img, 0, 0, width, height)
                            // Limit to ~48KB
                            let quality = 0.8
                            let dataUrl = canvas.toDataURL('image/webp', quality)
                            while (dataUrl.length > 50000 && quality > 0.2) {
                              quality -= 0.1
                              dataUrl = canvas.toDataURL('image/webp', quality)
                            }
                            setCustomIcon(dataUrl)
                          }
                        }
                        img.src = reader.result as string
                      }
                      reader.readAsDataURL(file)
                    }}
                  />
                </label>
                {/* Clear uploaded icon */}
                {customIcon.startsWith('data:') && (
                  <button
                    type="button"
                    onClick={() => setCustomIcon('')}
                    className="shrink-0 p-1 text-slate-500 transition-colors hover:text-red-400"
                    title={t('models.clearIcon')}
                  >
                    ✕
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">{t('models.customProviderIconHint')}</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.baseUrlLabel')}</label>
              <input
                type="text"
                value={customBaseUrl}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.apiKey')}</label>
              <div className="relative">
                <input
                  type={customShowKey ? 'text' : 'password'}
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  placeholder={PROVIDER_API_KEY_PLACEHOLDERS.lmstudio}
                  className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 pr-16 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
                <button type="button" onClick={() => setCustomShowKey((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-800 hover:text-slate-100">
                  {customShowKey ? t('models.hideApiKey') : t('models.showApiKey')}
                </button>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-700/40 pt-4">
              <Button variant="ghost" onClick={() => setShowCustomForm(false)}>{t('common.cancel')}</Button>
              <Button onClick={() => void handleCreateCustom()} disabled={!customName.trim() || !customBaseUrl.trim()}>
                {t('models.createProvider')}
              </Button>
            </div>
          </div>
        ) : (
          /* Standard provider model picker */
          <div className="space-y-4 p-5">
            {/* Provider selector */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.providerLabel')}</label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setProviderPickerOpen((o) => !o)}
                  className="flex h-11 w-full items-center gap-3 rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 pr-11 text-left text-sm text-slate-200 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  <ProviderLogo provider={provider} iconUrl={currentCustomConfig?.icon_url} />
                  <span className="min-w-0 truncate">{getProviderLabel(provider)}</span>
                </button>
                <span className="pointer-events-none absolute right-3 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-slate-400/90">
                  <ChevronIcon className={`h-4 w-4 transition-transform duration-200 ${providerPickerOpen ? 'rotate-180' : ''}`} />
                </span>
                {providerPickerOpen && (
                  <div className="absolute z-[70] mt-2 max-h-72 w-full overflow-auto rounded-xl border border-slate-700/60 bg-[#101219] p-2 shadow-2xl">
                    {PROVIDER_PICKER_GROUPS.map((group) => (
                      <div key={group.label} className="py-1 first:pt-0 last:pb-0">
                        <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 first:pt-0">{group.label}</p>
                        {group.options.map((opt) => {
                          const selected = opt.value === provider
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${selected ? 'bg-indigo-500/15 text-slate-100 ring-1 ring-indigo-500/30' : 'text-slate-300 hover:bg-slate-800'}`}
                              onClick={() => handleProviderChange(opt.value)}
                            >
                              <ProviderLogo provider={opt.value} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{opt.label}</span>
                              </span>
                              {savedProviderConfigs[opt.value]?.apiKey && (
                                <span className="text-[11px] text-emerald-300">🔑</span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    ))}

                    {/* Custom providers section */}
                    {customProviders.length > 0 && (
                      <div className="py-1">
                        <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          {t('models.customProviders')}
                        </p>
                        {customProviders.map((cp) => {
                          const selected = cp.provider === provider
                          return (
                            <button
                              key={cp.provider}
                              type="button"
                              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${selected ? 'bg-indigo-500/15 text-slate-100 ring-1 ring-indigo-500/30' : 'text-slate-300 hover:bg-slate-800'}`}
                              onClick={() => handleProviderChange(cp.provider)}
                            >
                              <ProviderLogo provider={cp.provider} iconUrl={cp.icon_url} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{cp.display_name || cp.provider}</span>
                              </span>
                              {cp.api_key && <span className="text-[11px] text-emerald-300">🔑</span>}
                              <span className="text-[10px] text-slate-600">{getHostname(cp.base_url)}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {/* Add custom provider button */}
                    <div className="border-t border-slate-700/40 pt-1 mt-1">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-indigo-300 transition hover:bg-slate-800 hover:text-indigo-200"
                        onClick={() => {
                          setShowCustomForm(true)
                          setProviderPickerOpen(false)
                        }}
                      >
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-dashed border-slate-600/50 text-xs">+</span>
                        <span>{t('models.addCustomProvider')}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* API Key + Base URL */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">
                  {t('models.apiKey')}
                  {hasSavedKey && <span className="ml-1 text-emerald-400">🔑</span>}
                </label>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      isBuiltIn
                        ? PROVIDER_API_KEY_PLACEHOLDERS[provider as ApiProvider]
                        : t('models.apiKeyOptional')
                    }
                    className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 pr-16 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                  <button type="button" onClick={() => setShowKey((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-800 hover:text-slate-100">
                    {showKey ? t('models.hideApiKey') : t('models.showApiKey')}
                  </button>
                </div>
                {hasSavedKey && apiKey !== (savedConfig?.apiKey || currentCustomConfig?.api_key) && (
                  <button type="button" onClick={useSavedKey} className="mt-1 text-xs text-emerald-300 hover:text-emerald-200">
                    {t('models.useSavedKey')}
                  </button>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">{t('models.baseUrlLabel')}</label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={getProviderPreset(provider) || 'https://api.example.com/v1'}
                  className="h-11 w-full rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>
            </div>

            {/* Save provider config button (for built-in providers) */}
            {isBuiltIn && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await saveConfig(provider, {
                      api_key: apiKey.trim() || null,
                      base_url: baseUrl.trim() || null,
                    })
                  }}
                >
                  🔑 {t('models.saveProviderKey')}
                </Button>
              </div>
            )}

            {/* Model list with toggles (only for built-in providers) */}
            {isBuiltIn && (
              <div className="rounded-xl border border-slate-700/40 bg-slate-950/30">
                <div className="flex items-center justify-between gap-3 border-b border-slate-700/40 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-200">{t('models.foundModels')}</p>
                    <p className="text-xs text-slate-500">
                      {t('models.selectedCount', { selected: selectedIds.size, total: providerModels.length })}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={selectAll}>{t('models.selectAll')}</Button>
                    <Button size="sm" variant="ghost" onClick={clearAll}>{t('models.clearAll')}</Button>
                  </div>
                </div>

                <div className="max-h-64 overflow-auto">
                  {providerModels.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-slate-500">
                      {scannedModels.length === 0
                        ? t('models.noScannedHint')
                        : t('models.noModelsForProvider')}
                    </p>
                  ) : (
                    providerModels.map((modelId) => {
                      const isSelected = selectedIds.has(modelId)
                      return (
                        <button
                          key={modelId}
                          type="button"
                          onClick={() => toggleModel(modelId)}
                          className={`flex w-full items-center gap-3 border-b border-slate-800/50 px-4 py-2.5 text-left transition last:border-b-0 hover:bg-slate-800/30 ${
                            isSelected ? 'bg-indigo-500/10' : ''
                          }`}
                        >
                          <ModelLogo provider={provider as ApiProvider} modelId={modelId} name={modelId} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-slate-200">{modelId}</span>
                            {existingModelById.has(modelId) && (
                              <span className="block text-[11px] text-slate-500">
                                {existingModelById.get(modelId)?.active ? t('models.currentlyEnabled') : t('models.currentlyDisabled')}
                              </span>
                            )}
                          </span>
                          <span
                            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                              isSelected ? 'bg-indigo-500' : 'bg-slate-700'
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                                isSelected ? 'translate-x-[18px]' : 'translate-x-[2px]'
                              }`}
                            />
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {/* Manual model entry for custom providers */}
            {!isBuiltIn && (
              <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-4">
                <p className="text-sm text-slate-400 mb-3">{t('models.customProviderModelHint')}</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    id="custom-model-input"
                    placeholder={t('models.modelIdLabel')}
                    className="h-11 flex-1 rounded-xl border border-slate-600/50 bg-[#0f1117] px-4 text-sm text-slate-200 placeholder:text-slate-600 transition-colors focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                        const val = e.currentTarget.value.trim()
                        setSelectedIds(new Set([val]))
                        e.currentTarget.value = ''
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      const input = document.getElementById('custom-model-input') as HTMLInputElement
                      if (input?.value.trim()) {
                        setSelectedIds(new Set([input.value.trim()]))
                        input.value = ''
                      }
                    }}
                  >
                    {t('common.add')}
                  </Button>
                </div>
                {selectedIds.size > 0 && (
                  <div className="mt-2">
                    {[...selectedIds].map((id) => (
                      <div key={id} className="flex items-center gap-2 rounded-lg bg-indigo-500/10 px-3 py-1.5">
                        <span className="text-sm text-slate-200">{id}</span>
                        <button onClick={() => setSelectedIds(new Set())} className="text-xs text-slate-500 hover:text-red-400">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex justify-end gap-2 border-t border-slate-700/40 pt-4">
              <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
              <Button onClick={() => void handleAdd()} disabled={!canApply || isAdding}>
                {isAdding ? t('models.adding') : t('models.saveSelection')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
