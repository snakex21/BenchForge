// ============================================================
// CompareView — porównanie modeli (tabela, wykresy, ranking)
// Używa gotowych komponentów BenchmarkMatrix, HorizontalBarChart, BenchmarkRadarChart
// ============================================================

import React, { useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ModelLogo } from '@/components/ui/ModelLogo'
import { BenchmarkMatrix } from '@/components/benchmark/BenchmarkMatrix'
import { HorizontalBarChart } from '@/components/benchmark/HorizontalBarChart'
import { BenchmarkRadarChart } from '@/components/benchmark/BenchmarkRadarChart'
import { useBenchmarkStore } from '@/store/benchmarkStore'
import { useModelStore } from '@/store/modelStore'
import { useResultStore } from '@/store/resultStore'
import { useUIStore } from '@/store/uiStore'
import { useTranslation } from '@/i18n'
import { getModelBenchmarkScore, getModelSummary } from '@/utils/scoring'
import type { AIModel } from '@/types'

type CompareTab = 'table' | 'bar' | 'shape' | 'ranking'
const MODEL_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#f43f5e']

export const CompareView: React.FC = () => {
  const models = useModelStore((state) => state.models)
  const benchmarks = useBenchmarkStore((state) => state.benchmarks)
  const results = useResultStore((state) => state.results)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const { t } = useTranslation()

  const [draftSelection, setDraftSelection] = useState<number[]>([])
  const [selectedModelIds, setSelectedModelIds] = useState<number[]>([])
  const [activeTab, setActiveTab] = useState<CompareTab>('table')
  const [expandedRankingModels, setExpandedRankingModels] = useState<number[]>([])

  const TAB_LABELS: Array<{ id: CompareTab; label: string }> = [
    { id: 'table', label: t('compare.tabTable') },
    { id: 'bar', label: t('compare.tabBar') },
    { id: 'shape', label: t('compare.tabShape') },
    { id: 'ranking', label: t('compare.tabRanking') },
  ]

  const selectedModels = useMemo<AIModel[]>(
    () => selectedModelIds.map((id) => models.find((m) => m.id === id)).filter((m): m is AIModel => Boolean(m)),
    [models, selectedModelIds],
  )

  const comparisonData = useMemo(
    () =>
      selectedModels.map((model, index) => ({
        model,
        color: MODEL_COLORS[index % MODEL_COLORS.length],
        summary: getModelSummary(model.id, results, benchmarks),
      })),
    [benchmarks, results, selectedModels],
  )

  const hasAnyResults = comparisonData.some((entry) => entry.summary.percent > 0)

  const toggleModel = (id: number) =>
    setDraftSelection((current) =>
      current.includes(id) ? current.filter((v) => v !== id) : [...current, id].slice(0, 4),
    )

  const toggleRankingModel = (modelId: number) =>
    setExpandedRankingModels((current) =>
      current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId],
    )

  // Get active models only (filter by active flag)
  const activeModels = useMemo(() => models.filter((m) => m.active !== false), [models])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-100">{t('compare.title')}</h2>
          <p className="mt-1 text-sm text-slate-500">{t('compare.selectModelsHint')}</p>
        </div>
        <Button onClick={() => setSelectedModelIds(draftSelection)} disabled={draftSelection.length < 2}>
          {t('compare.button')}
        </Button>
      </div>

      {/* Model selection grid */}
      <Card title={t('compare.selectModels')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {activeModels.map((model) => {
            const checked = draftSelection.includes(model.id)
            return (
              <label
                key={model.id}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition ${
                  checked
                    ? 'border-indigo-400/70 bg-indigo-500/10'
                    : 'border-slate-700/30 bg-slate-950/20 hover:bg-slate-700/20'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleModel(model.id)}
                  className="h-4 w-4 rounded accent-indigo-500"
                />
                <ModelLogo model={model} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-200">{model.name}</p>
                  <p className="truncate text-[11px] text-slate-500">
                    {model.model_id || model.provider || ''}
                  </p>
                </div>
              </label>
            )
          })}
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {TAB_LABELS.map((tab) => (
          <Button
            key={tab.id}
            variant={activeTab === tab.id ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {/* Content */}
      {selectedModelIds.length < 2 ? (
        <EmptyState
          icon="chart"
          title={t('compare.selectModelsEmpty')}
          description={t('compare.selectModelsEmptyDesc')}
        />
      ) : !hasAnyResults ? (
        <EmptyState
          icon="chart"
          title={t('compare.noResults')}
          description={t('compare.noResultsDesc')}
          actionLabel={t('compare.goToRunner')}
          onAction={() => setActiveView('runner')}
        />
      ) : (
        <>
          {activeTab === 'table' && (
            <Card title={t('compare.tabTable')}>
              <BenchmarkMatrix benchmarksOverride={benchmarks} onModelOpen={() => {}} />
            </Card>
          )}

          {activeTab === 'bar' && (
            <Card title={t('compare.tabBar')}>
              <HorizontalBarChart models={selectedModels} benchmarks={benchmarks} results={results} />
            </Card>
          )}

          {activeTab === 'shape' && (
            <Card title={t('compare.tabShape')}>
              <BenchmarkRadarChart models={selectedModels} benchmarks={benchmarks} results={results} />
            </Card>
          )}

          {activeTab === 'ranking' && (
            <Card title={t('compare.tabRanking')}>
              <div className="space-y-3">
                {[...comparisonData]
                  .sort((a, b) => b.summary.percent - a.summary.percent)
                  .map((entry, index) => {
                    const expanded = expandedRankingModels.includes(entry.model.id)
                    const medals = ['🥇', '🥈', '🥉']
                    return (
                      <div key={entry.model.id} className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-4">
                        <div className="flex items-center gap-3">
                          <div className="text-xl shrink-0">{medals[index] || index + 1}</div>
                          <ModelLogo model={entry.model} size="md" />
                          <div
                            className="min-w-0 flex-1 border-l-4 pl-3"
                            style={{ borderColor: entry.color }}
                          >
                            <button
                              className="w-full text-left"
                              onClick={() => toggleRankingModel(entry.model.id)}
                            >
                              <p className="truncate text-sm font-semibold text-slate-200">
                                {entry.model.name}
                              </p>
                              <p className="text-xs text-slate-500">
                                {entry.summary.avgDisplay} · {entry.summary.percent}%
                              </p>
                            </button>
                            {/* Progress bar */}
                            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{
                                  width: `${entry.summary.percent}%`,
                                  backgroundColor: entry.color,
                                }}
                              />
                            </div>
                            {/* Expanded per-benchmark details */}
                            {expanded && (
                              <div className="mt-3 space-y-2">
                                {benchmarks.map((benchmark) => {
                                  const stat = getModelBenchmarkScore(
                                    entry.model.id,
                                    benchmark.id,
                                    results,
                                    benchmark,
                                  )
                                  return (
                                    <div
                                      key={benchmark.id}
                                      className="flex items-center justify-between rounded-lg bg-slate-900/50 px-3 py-2 text-xs"
                                    >
                                      <span className="text-slate-300">{benchmark.name}</span>
                                      <span className="text-slate-500">
                                        {stat ? `${stat.percent}% (${stat.scoreRaw})` : '-'}
                                      </span>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
