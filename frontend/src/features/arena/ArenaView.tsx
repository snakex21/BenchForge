// ============================================================
// ArenaView — centrum analityczne z 8 trybami wizualizacji
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { BenchmarkMatrix } from '@/components/benchmark/BenchmarkMatrix'
import { RecentRuns } from '@/components/benchmark/RecentRuns'
import { HorizontalBarChart } from '@/components/benchmark/HorizontalBarChart'
import { BenchmarkRadarChart } from '@/components/benchmark/BenchmarkRadarChart'
import { TrendLineChart } from '@/components/benchmark/TrendLineChart'
import { ModelResultsModal } from '@/components/benchmark/ModelResultsModal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { ModelLogo } from '@/components/ui/ModelLogo'
import { useBenchmarkStore } from '@/store/benchmarkStore'
import { useModelStore } from '@/store/modelStore'
import { useResultStore } from '@/store/resultStore'
import { useUIStore } from '@/store/uiStore'
import { useTranslation, type TranslationKey } from '@/i18n'
import { getModelBenchmarkScore, getModelSummary } from '@/utils/scoring'

type ArenaMode = 'table' | 'list' | 'aa' | 'radar' | 'ranking' | 'trend' | 'categories'

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#06b6d4', '#a855f7', '#ec4899', '#14b8a6']
const CATEGORY_COLORS: Record<string, string> = {
  Logika: '#6366f1', Wiedza: '#10b981', Kod: '#f59e0b',
  Kreatywność: '#f43f5e', Wizja: '#06b6d4', Inne: '#8b5cf6',
}

export const ArenaView: React.FC = () => {
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setRerunTarget = useUIStore((s) => s.setRerunTarget)
  const selectModel = useUIStore((s) => s.selectModel)
  const selectBenchmark = useUIStore((s) => s.selectBenchmark)
  const models = useModelStore((s) => s.models)
  const benchmarks = useBenchmarkStore((s) => s.benchmarks)
  const results = useResultStore((s) => s.results)
  const { t } = useTranslation()
  const [mode, setMode] = useState<ArenaMode>('table')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [benchmarkFilter, setBenchmarkFilter] = useState<number | ''>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedRanking, setExpandedRanking] = useState<number[]>([])
  const [modelModalId, setModelModalId] = useState<number | null>(null)

  const categories = useMemo(() => Array.from(new Set(benchmarks.map((b) => b.category))), [benchmarks])

  useEffect(() => {
    if (!benchmarkFilter || !categoryFilter) return
    const selected = benchmarks.find((benchmark) => benchmark.id === benchmarkFilter)
    if (selected && selected.category !== categoryFilter) setBenchmarkFilter('')
  }, [benchmarks, benchmarkFilter, categoryFilter])

  const filteredBenchmarks = useMemo(() => {
    let filtered = benchmarks
    if (categoryFilter) filtered = filtered.filter((b) => b.category === categoryFilter)
    if (benchmarkFilter) filtered = filtered.filter((b) => b.id === benchmarkFilter)
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter((b) => b.name.toLowerCase().includes(q))
    }
    return filtered
  }, [benchmarks, benchmarkFilter, categoryFilter, searchQuery])

  const rankingData = useMemo(() => models.map((model, index) => {
    const summary = getModelSummary(model.id, results, benchmarks)
    return { model, summary, color: COLORS[index % COLORS.length] }
  }).sort((a, b) => b.summary.percent - a.summary.percent), [models, benchmarks, results])

  const categoriesData = useMemo(() => {
    return categories.map((cat) => {
      const catBenchmarks = filteredBenchmarks.filter((b) => b.category === cat)
      const modelScores = models.map((model, i) => {
        const scores = catBenchmarks.map((b) => getModelBenchmarkScore(model.id, b.id, results, b)).filter(Boolean)
        const avg = scores.length ? Math.round(scores.reduce((sum, s) => sum + (s?.scoreNorm || 0), 0) / scores.length * 100) : 0
        return { model, percent: avg, color: COLORS[i % COLORS.length] }
      }).sort((a, b) => b.percent - a.percent)
      return { category: cat, color: CATEGORY_COLORS[cat] || '#8b5cf6', modelScores }
    }).filter((c) => c.modelScores.length > 0 && c.modelScores.some((m) => m.percent > 0))
  }, [categories, filteredBenchmarks, models, results])

  const toggleRanking = useCallback((id: number) => setExpandedRanking((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id]), [])
  const openModelModal = useCallback((modelId: number) => {
    selectModel(modelId)
    setModelModalId(modelId)
  }, [selectModel])
  const rerunFromArena = useCallback((modelId: number, benchmarkId: number) => {
    setRerunTarget({ modelId, benchmarkId })
    setActiveView('runner')
  }, [setRerunTarget, setActiveView])

  // Mode buttons
  const modes: Array<{ id: ArenaMode; labelKey: TranslationKey }> = useMemo(() => [
    { id: 'table', labelKey: 'arena.mode.table' },
    { id: 'list', labelKey: 'arena.mode.list' },
    { id: 'aa', labelKey: 'arena.mode.bars' },
    { id: 'radar', labelKey: 'arena.mode.radar' },
    { id: 'ranking', labelKey: 'arena.mode.ranking' },
    { id: 'trend', labelKey: 'arena.mode.trend' },
    { id: 'categories', labelKey: 'arena.mode.categories' },
  ], [])

  // ---- RENDERERS ----

  const renderList = () => (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(26rem,100%),1fr))] gap-3">
      {filteredBenchmarks.map((benchmark) => (
        <section key={benchmark.id} className="rounded-xl border border-slate-700/40 bg-[#1c1f2e] p-[clamp(0.75rem,1vw,1rem)]">
          <button className="w-full text-left" onClick={() => selectBenchmark(benchmark.id)}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-100">{benchmark.name}</p>
                <p className="text-xs text-slate-500">{benchmark.category} · {benchmark.score_type}</p>
              </div>
              <Badge variant="neutral">{benchmark.output_type}</Badge>
            </div>
          </button>
          <div className="mt-3 space-y-2">
            {models.map((model) => {
              const score = getModelBenchmarkScore(model.id, benchmark.id, results, benchmark)
              return (
                <button key={model.id} className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-700/30 bg-slate-950/30 p-2 text-left hover:bg-slate-800/30" onClick={() => openModelModal(model.id)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <ModelLogo model={model} size="sm" />
                    <span className="truncate text-xs text-slate-300">{model.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">{score ? (score.scoreRaw.includes('/') ? `${score.percent}% (${score.scoreRaw})` : `${score.percent}%`) : '—'}</span>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )

  const renderRadar = () => <BenchmarkRadarChart models={models} benchmarks={filteredBenchmarks} results={results} />

  const renderRanking = () => {
    const medals = ['🥇', '🥈', '🥉']

    if (rankingData.length === 0) {
      return <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-slate-700/60 text-sm text-slate-500">{t('arena.noRanking')}</div>
    }

    return (
      <div className="space-y-3">
        {rankingData.map((entry, index) => {
          const isOpen = expandedRanking.includes(entry.model.id)
          return (
            <div key={entry.model.id} className="rounded-xl border border-slate-700/40 bg-[#1c1f2e] p-4">
              <div className="flex min-w-0 flex-1 gap-3">
                <div className="text-lg">{medals[index] || index + 1}</div>
                <ModelLogo model={entry.model} size="md" />
                <div className="min-w-0 flex-1 border-l-4 pl-3" style={{ borderColor: entry.color }}>
                  <button className="w-full text-left" onClick={() => toggleRanking(entry.model.id)}>
                    <p className="truncate text-sm font-semibold text-slate-200">{entry.model.name}</p>
                    <p className="text-xs text-slate-500">{entry.summary.avgDisplay} · {entry.summary.percent}%</p>
                  </button>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full" style={{ width: `${entry.summary.percent}%`, backgroundColor: entry.color }} />
                  </div>
                  {isOpen && (
                    <div className="mt-3 space-y-2">
                      {benchmarks.map((benchmark) => {
                        const stat = getModelBenchmarkScore(entry.model.id, benchmark.id, results, benchmark)
                        return (
                          <div key={benchmark.id} className="flex items-center justify-between rounded-lg bg-slate-900/50 p-3 text-xs">
                            <span className="text-slate-300">{benchmark.name}</span>
                            <span className="text-slate-500">{stat ? `${stat.percent}% (${stat.scoreRaw})` : '-'}</span>
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
    )
  }

  const renderCategories = () => {
    if (categoriesData.length === 0) {
      return <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-slate-700/60 text-sm text-slate-500">{t('arena.noCategoryData')}</div>
    }

    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {categoriesData.map((cat) => (
          <Card key={cat.category} title={cat.category}>
            <div className="space-y-3">
              {cat.modelScores.map((entry) => (
                <div key={entry.model.id} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-300">{entry.model.name}</span>
                    <span className="text-slate-400">{entry.percent}%</span>
                  </div>
                  <svg width="100%" height="14">
                    <rect width="100%" height="14" rx="7" fill="#1e293b" />
                    <rect width={`${entry.percent}%`} height="14" rx="7" fill={entry.percent >= 80 ? '#10b981' : entry.percent >= 50 ? '#f59e0b' : '#f43f5e'} />
                  </svg>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    )
  }

  const modalModel = modelModalId ? models.find((model) => model.id === modelModalId) || null : null

  return (
    <div className="space-y-6">
      {/* Hero header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-slate-100 mb-1">
            {t('arena.title')}
          </h2>
          <p className="text-sm text-slate-500 max-w-lg">
            {t('arena.subtitle')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setActiveView('models')}>
            {t('arena.addModel')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setActiveView('benchmarks')}>
            {t('arena.addBenchmark')}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {categoryFilter && (
          <button
            type="button"
            onClick={() => setCategoryFilter('')}
            className="rounded-lg border border-indigo-400/60 bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-300 hover:bg-indigo-500/20"
          >
            {categoryFilter} ✕
          </button>
        )}
        {benchmarkFilter && (
          <button
            type="button"
            onClick={() => setBenchmarkFilter('')}
            className="rounded-lg border border-cyan-400/60 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20"
          >
            {benchmarks.find((benchmark) => benchmark.id === benchmarkFilter)?.name || 'Benchmark'} ✕
          </button>
        )}
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-300 outline-none focus:border-indigo-500/60"
        >
          <option value="">{t('arena.allCategories')}</option>
          {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
        </select>
        <select
          value={benchmarkFilter}
          onChange={(e) => setBenchmarkFilter(e.target.value ? Number(e.target.value) : '')}
          className="w-full max-w-[280px] rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-300 outline-none focus:border-indigo-500/60 sm:w-auto"
        >
          <option value="">{t('arena.allBenchmarks')}</option>
          {benchmarks
            .filter((benchmark) => !categoryFilter || benchmark.category === categoryFilter)
            .map((benchmark) => <option key={benchmark.id} value={benchmark.id}>{benchmark.name}</option>)}
        </select>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('arena.searchBenchmark')}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-300 outline-none placeholder:text-slate-600 focus:border-indigo-500/60 sm:w-48"
        />
      </div>

      {/* Mode switchers */}
      <div className="flex flex-wrap gap-1.5">
        {modes.map((m) => (
          <Button key={m.id} variant={mode === m.id ? 'primary' : 'secondary'} size="sm" onClick={() => setMode(m.id)}>
            {t(m.labelKey)}
          </Button>
        ))}
      </div>

      {/* Render selected mode */}
      {mode === 'table' && <BenchmarkMatrix benchmarksOverride={filteredBenchmarks} onModelOpen={openModelModal} />}
      {mode === 'list' && renderList()}
      {mode === 'aa' && <HorizontalBarChart models={models} benchmarks={filteredBenchmarks} results={results} />}
      {mode === 'radar' && renderRadar()}
      {mode === 'ranking' && renderRanking()}
      {mode === 'trend' && <TrendLineChart models={models} benchmarks={filteredBenchmarks} results={results} title={t('arena.trendTitle')} />}
      {mode === 'categories' && renderCategories()}

      {/* Recent runs */}
      <RecentRuns />

      {modalModel && (
        <ModelResultsModal
          model={modalModel}
          benchmarks={filteredBenchmarks}
          results={results}
          onClose={() => setModelModalId(null)}
          onOpenResults={() => { setModelModalId(null); setActiveView('results') }}
          onRerun={rerunFromArena}
        />
      )}
    </div>
  )
}
