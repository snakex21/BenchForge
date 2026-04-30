import React, { useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ModelLogo } from '@/components/ui/ModelLogo'
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
  const [expandedBenchmarks, setExpandedBenchmarks] = useState<number[]>([])
  const [expandedRankingModels, setExpandedRankingModels] = useState<number[]>([])

  const TAB_LABELS: Array<{ id: CompareTab; label: string }> = [
    { id: 'table', label: t('compare.tabTable') },
    { id: 'bar', label: t('compare.tabBar') },
    { id: 'shape', label: t('compare.tabShape') },
    { id: 'ranking', label: t('compare.tabRanking') },
  ]

  const selectedModels = useMemo<AIModel[]>(() => selectedModelIds.map((id) => models.find((model) => model.id === id)).filter((model): model is AIModel => Boolean(model)), [models, selectedModelIds])
  const comparisonData = useMemo(() => selectedModels.map((model, index) => ({
    model,
    color: MODEL_COLORS[index % MODEL_COLORS.length],
    summary: getModelSummary(model.id, results, benchmarks),
  })), [benchmarks, results, selectedModels])
  const hasAnyResults = comparisonData.some((entry) => entry.summary.percent > 0)
  const toggleModel = (id: number) => setDraftSelection((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]).slice(0, 4))
  const toggleExpandedBenchmark = (benchmarkId: number) => setExpandedBenchmarks((current) => current.includes(benchmarkId) ? current.filter((id) => id !== benchmarkId) : [...current, benchmarkId])
  const toggleRankingModel = (modelId: number) => setExpandedRankingModels((current) => current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId])

  const resultFor = (modelId: number, benchmarkId: number) => [...results].filter((result) => result.model_id === modelId && result.benchmark_id === benchmarkId).sort((a, b) => new Date(b.run_at).getTime() - new Date(a.run_at).getTime())[0]

  const renderTable = () => <div className="overflow-x-auto rounded-xl border border-slate-700/40 bg-[#1c1f2e]"><table className="w-full min-w-[840px]"><thead><tr className="border-b border-slate-700/40"><th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Benchmark</th>{comparisonData.map(({ model, color }) => <th key={model.id} className="px-4 py-3 text-left text-xs font-semibold text-slate-300"><span className="inline-flex min-w-0 items-center gap-2"><ModelLogo model={model} size="sm" /><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} /><span className="truncate">{model.name}</span></span></th>)}</tr></thead><tbody>{benchmarks.map((benchmark) => { const expanded = expandedBenchmarks.includes(benchmark.id); return <React.Fragment key={benchmark.id}><tr className="cursor-pointer border-b border-slate-700/20 last:border-0" onClick={() => toggleExpandedBenchmark(benchmark.id)}><td className="px-4 py-3 text-sm text-slate-300">{expanded ? '▼ ' : '▶ '}{benchmark.name}</td>{comparisonData.map(({ model }) => { const stat = getModelBenchmarkScore(model.id, benchmark.id, results, benchmark); const opacity = stat ? 0.12 + stat.scoreNorm * 0.35 : 0.06; return <td key={`${model.id}-${benchmark.id}`} className="px-4 py-3" style={{ backgroundColor: `rgba(99,102,241,${opacity})` }}>{stat ? <div><p className="text-sm font-medium text-slate-200">{stat.scoreRaw}</p><p className="text-[11px] text-slate-400">{stat.percent}%</p></div> : <div className="text-sm text-slate-500">-</div>}</td> })}</tr>{expanded && <tr className="border-b border-slate-800/80 bg-[#171922]"><td className="px-6 py-2 text-xs text-slate-400">{t('compare.modelResponses')}</td>{comparisonData.map(({ model }) => { const result = resultFor(model.id, benchmark.id); return <td key={`${model.id}-${benchmark.id}-notes`} className="px-4 py-2 text-xs text-slate-400"><details><summary className="cursor-pointer">notes</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-[10px]">{result?.notes || '—'}</pre></details></td> })}</tr>}</React.Fragment> })}</tbody></table></div>

  const renderBarChart = () => { const chartHeight = 280; const groupWidth = 120; const barWidth = Math.max(18, 72 / Math.max(comparisonData.length, 1)); const svgWidth = Math.max(benchmarks.length * groupWidth, 720); return <div className="space-y-4 overflow-x-auto"><div className="flex flex-wrap gap-3">{comparisonData.map(({ model, color }) => <div key={model.id} className="flex items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-950/30 px-3 py-2 text-xs text-slate-400"><ModelLogo model={model} size="sm" /><span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />{model.name}</div>)}</div><svg width={svgWidth} height={chartHeight + 40} className="rounded-xl border border-slate-700/40 bg-[#1c1f2e] p-4">{[0, 25, 50, 75, 100].map((tick) => { const y = 20 + ((100 - tick) / 100) * chartHeight; return <g key={tick}><line x1={40} y1={y} x2={svgWidth - 20} y2={y} stroke="rgba(148,163,184,0.15)" /><text x={8} y={y + 4} fill="#94a3b8" fontSize="11">{tick}%</text></g> })}{benchmarks.map((benchmark, itemIndex) => { const groupX = 60 + itemIndex * groupWidth; return <g key={benchmark.id}>{comparisonData.map(({ model, color }, modelIndex) => { const percent = getModelBenchmarkScore(model.id, benchmark.id, results, benchmark)?.percent || 0; const barHeight = (percent / 100) * chartHeight; const x = groupX + modelIndex * (barWidth + 8); const y = 20 + chartHeight - barHeight; return <g key={model.id}><rect x={x} y={y} width={barWidth} height={barHeight} rx={6} fill={color} opacity={0.9} /><text x={x + barWidth / 2} y={y + 16} textAnchor="middle" fill="#e2e8f0" fontSize="10">{percent}%</text></g> })}<text x={groupX + 18} y={chartHeight + 34} textAnchor="middle" fill="#94a3b8" fontSize="11">{benchmark.name.slice(0, 14)}</text></g> })}</svg></div> }

  const renderRadar = () => { const size = 560; const cx = size / 2; const cy = size / 2; const r = 190; const steps = [0.25, 0.5, 0.75, 1]; const axisPoints = benchmarks.map((benchmark, index) => { const angle = (2 * Math.PI * index / Math.max(benchmarks.length, 1)) - Math.PI / 2; return { benchmark, angle, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) } }); return <div className="space-y-4 overflow-x-auto"><div className="flex flex-wrap gap-3">{comparisonData.map(({ model, color }) => <div key={model.id} className="flex items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-950/30 px-3 py-2 text-xs text-slate-400"><ModelLogo model={model} size="sm" /><span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />{model.name}</div>)}</div><svg width={size} height={size} className="rounded-xl border border-slate-700/40 bg-[#1c1f2e] p-4">{steps.map((step) => <polygon key={step} points={axisPoints.map((point) => `${cx + r * step * Math.cos(point.angle)},${cy + r * step * Math.sin(point.angle)}`).join(' ')} fill="none" stroke="rgba(148,163,184,0.16)" />)}{axisPoints.map((point) => <g key={point.benchmark.id}><line x1={cx} y1={cy} x2={point.x} y2={point.y} stroke="rgba(148,163,184,0.18)" /><text x={cx + r * 1.18 * Math.cos(point.angle)} y={cy + r * 1.18 * Math.sin(point.angle)} fill="#cbd5e1" fontSize="11" textAnchor={Math.cos(point.angle) < -0.1 ? 'end' : Math.cos(point.angle) > 0.1 ? 'start' : 'middle'}>{point.benchmark.name.slice(0, 12)}</text></g>)}{comparisonData.map(({ model, color }) => <g key={model.id}><polygon points={axisPoints.map((point) => { const score = getModelBenchmarkScore(model.id, point.benchmark.id, results, point.benchmark)?.scoreNorm || 0; return `${cx + r * score * Math.cos(point.angle)},${cy + r * score * Math.sin(point.angle)}` }).join(' ')} fill={color} opacity={0.3} stroke={color} strokeWidth={2} /></g>)}</svg></div> }

  const renderRanking = () => { const ranking = [...comparisonData].sort((a, b) => b.summary.percent - a.summary.percent); const medals = ['🥇', '🥈', '🥉']; return <div className="space-y-3">{ranking.map((entry, index) => { const modelExpanded = expandedRankingModels.includes(entry.model.id); return <div key={entry.model.id} className="rounded-xl border border-slate-700/40 bg-[#1c1f2e] p-4"><div className="flex min-w-0 flex-1 gap-3"><div className="text-lg">{medals[index] || index + 1}</div><ModelLogo model={entry.model} size="md" /><div className="min-w-0 flex-1 border-l-4 pl-3" style={{ borderColor: entry.color }}><button className="w-full text-left" onClick={() => toggleRankingModel(entry.model.id)}><p className="truncate text-sm font-semibold text-slate-200">{entry.model.name}</p><p className="text-xs text-slate-500">{entry.summary.avgDisplay} · {entry.summary.percent}%</p></button><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full" style={{ width: `${entry.summary.percent}%`, backgroundColor: entry.color }} /></div>{modelExpanded && <div className="mt-3 space-y-2">{benchmarks.map((benchmark) => { const stat = getModelBenchmarkScore(entry.model.id, benchmark.id, results, benchmark); return <div key={benchmark.id} className="flex items-center justify-between rounded-lg bg-slate-900/50 p-3 text-xs"><span className="text-slate-300">{benchmark.name}</span><span className="text-slate-500">{stat ? `${stat.percent}% (${stat.scoreRaw})` : '-'}</span></div> })}</div>}</div></div></div> })}</div> }

  return <div className="space-y-6">
    <div className="flex items-center justify-between">
      <h2 className="text-xl font-bold text-slate-100">{t('compare.title')}</h2>
      <Button onClick={() => setSelectedModelIds(draftSelection)} disabled={draftSelection.length < 2}>{t('compare.button')}</Button>
    </div>

    <Card title={t('compare.selectModels')} subtitle={t('compare.selectModelsHint')}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {models.map((model) => {
          const checked = draftSelection.includes(model.id)
          return <label key={model.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${checked ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-slate-700/40 bg-slate-950/20 hover:bg-slate-700/20'}`}>
            <input type="checkbox" checked={checked} onChange={() => toggleModel(model.id)} />
            <ModelLogo model={model} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-200">{model.name}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-200">{model.mode}</span>
                {model.provider && <span className="rounded-md border border-slate-600/50 bg-slate-800/60 px-1.5 py-0.5 text-[10px] text-slate-300">{model.provider}</span>}
              </div>
              {model.model_id && <p className="mt-1 truncate text-[11px] text-slate-500">{model.model_id}</p>}
            </div>
          </label>
        })}
      </div>
    </Card>

    <div className="flex flex-wrap gap-2">{TAB_LABELS.map((tab) => <Button key={tab.id} variant={activeTab === tab.id ? 'primary' : 'secondary'} size="sm" onClick={() => setActiveTab(tab.id)}>{tab.label}</Button>)}</div>
    {selectedModelIds.length < 2 ? <EmptyState icon="chart" title={t('compare.selectModelsEmpty')} description={t('compare.selectModelsEmptyDesc')} /> : !hasAnyResults ? <EmptyState icon="chart" title={t('compare.noResults')} description={t('compare.noResultsDesc')} actionLabel={t('compare.goToRunner')} onAction={() => setActiveView('runner')} /> : <Card title={t('compare.viewTitle')}>{activeTab === 'table' && renderTable()}{activeTab === 'bar' && renderBarChart()}{activeTab === 'shape' && renderRadar()}{activeTab === 'ranking' && renderRanking()}</Card>}
  </div>
}
