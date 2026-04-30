import React, { useMemo, useState } from 'react'
import { ModelLogo } from '@/components/ui/ModelLogo'
import type { AIModel, Benchmark } from '@/types'
import type { BenchmarkResult } from '@/types'
import { getModelBenchmarkScore } from '@/utils/scoring'
import { useTranslation } from '@/i18n'

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#06b6d4', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6']

interface HorizontalBarChartProps {
  models: AIModel[]
  benchmarks: Benchmark[]
  results: BenchmarkResult[]
}

export const HorizontalBarChart: React.FC<HorizontalBarChartProps> = ({ models, benchmarks, results }) => {
  const { t } = useTranslation()
  const chartData = useMemo(() => {
    return models.map((model, modelIndex) => {
      const segments = benchmarks.map((benchmark) => {
        const score = getModelBenchmarkScore(model.id, benchmark.id, results, benchmark)
        return {
          benchmarkId: benchmark.id,
          benchmarkName: benchmark.name,
          category: benchmark.category,
          percent: score?.percent || 0,
          scoreRaw: score?.scoreRaw || '-',
        }
      })
      const totalPercent = Math.round(segments.reduce((sum, s) => sum + s.percent, 0) / Math.max(benchmarks.length, 1))
      return { model, color: COLORS[modelIndex % COLORS.length], segments, totalPercent }
    }).sort((a, b) => b.totalPercent - a.totalPercent)
  }, [models, benchmarks, results])

  const [sortBy, setSortBy] = useState<'total' | 'name'>('total')
  const sorted = useMemo(() => {
    if (sortBy === 'name') return [...chartData].sort((a, b) => a.model.name.localeCompare(b.model.name))
    return chartData
  }, [chartData, sortBy])

  if (benchmarks.length === 0 || models.length === 0) {
    return <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-slate-700/60 text-sm text-slate-500">{t('bars.empty')}</div>
  }

  const chartWidth = Math.max(600, sorted.length * 100 + 120)
  const chartHeight = 340
  const padTop = 20
  const padBottom = 60
  const padLeft = 50
  const padRight = 20
  const plotHeight = chartHeight - padTop - padBottom
  const colWidth = Math.min(72, (chartWidth - padLeft - padRight) / Math.max(sorted.length, 1) - 8)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">{t('bars.sort')}</span>
        <button type="button" onClick={() => setSortBy('total')} className={`rounded-lg px-2.5 py-1 text-xs transition ${sortBy === 'total' ? 'border border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border border-slate-700/40 text-slate-400 hover:bg-slate-800/50'}`}>{t('bars.byScore')}</button>
        <button type="button" onClick={() => setSortBy('name')} className={`rounded-lg px-2.5 py-1 text-xs transition ${sortBy === 'name' ? 'border border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border border-slate-700/40 text-slate-400 hover:bg-slate-800/50'}`}>{t('bars.alphabetically')}</button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3">
        {benchmarks.map((benchmark, index) => (
          <div key={benchmark.id} className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
            {benchmark.name.slice(0, 16)}{benchmark.name.length > 16 ? '…' : ''}
          </div>
        ))}
      </div>

      {/* Vertical bar chart */}
      <div className="overflow-x-auto rounded-xl border border-slate-700/40 bg-[#1c1f2e] p-4">
        <svg width={chartWidth} height={chartHeight} className="text-xs">
          {/* Grid lines */}
          {[0, 25, 50, 75, 100].map((tick) => {
            const y = padTop + plotHeight - (tick / 100) * plotHeight
            return (
              <g key={tick}>
                <line x1={padLeft} y1={y} x2={chartWidth - padRight} y2={y} stroke={tick === 50 ? 'rgba(148,163,184,0.20)' : 'rgba(148,163,184,0.08)'} strokeDasharray={tick === 50 ? '' : '4 4'} />
                <text x={padLeft - 8} y={y + 4} fill="#64748b" textAnchor="end" fontSize="11">{tick}%</text>
              </g>
            )
          })}

          {/* Baseline */}
          <line x1={padLeft} y1={padTop + plotHeight} x2={chartWidth - padRight} y2={padTop + plotHeight} stroke="rgba(148,163,184,0.25)" strokeWidth={1.5} />

          {/* Bars */}
          {sorted.map((row, colIndex) => {
            const colX = padLeft + colIndex * ((chartWidth - padLeft - padRight) / Math.max(sorted.length, 1)) + 4
            let accY = padTop + plotHeight // start from bottom

            return (
              <g key={row.model.id}>
                {/* Model label at bottom */}
                <foreignObject x={colX - 12} y={chartHeight - 48} width={colWidth + 24} height={40}>
                  <div className="flex flex-col items-center gap-0.5 text-center">
                    <ModelLogo model={row.model} size="sm" />
                    <span className="text-[9px] text-slate-400 leading-tight truncate max-w-full">{row.model.name.slice(0, 12)}</span>
                  </div>
                </foreignObject>

                {/* Stacked segments from bottom up */}
                {row.segments.map((seg) => {
                  const segHeight = Math.max(0, (seg.percent / 100) * plotHeight)
                  const barY = accY - segHeight
                  accY = barY
                  return (
                    <g key={seg.benchmarkId}>
                      <rect
                        x={colX}
                        y={barY}
                        width={colWidth}
                        height={Math.max(segHeight, seg.percent > 0 ? 2 : 0)}
                        rx={2}
                        fill={COLORS[benchmarks.findIndex((b) => b.id === seg.benchmarkId) % COLORS.length]}
                        opacity={seg.percent > 0 ? 0.85 : 0.15}
                      >
                        {segHeight > 10 && <title>{`${seg.benchmarkName}: ${seg.percent}% (${seg.scoreRaw})`}</title>}
                      </rect>
                    </g>
                  )
                })}

                {/* Total percent label on top of bar */}
                <text x={colX + colWidth / 2} y={padTop + plotHeight - (row.totalPercent / 100) * plotHeight - 10} fill="#e2e8f0" textAnchor="middle" fontWeight="600" fontSize="12">
                  {row.totalPercent}%
                </text>

                {/* Column number */}
                <text x={colX + colWidth / 2} y={chartHeight - 6} fill="#475569" textAnchor="middle" fontSize="10">
                  {colIndex + 1}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      {/* Details table */}
      <details className="rounded-xl border border-slate-700/40 bg-slate-950/30">
        <summary className="cursor-pointer px-4 py-2 text-sm text-slate-400">{t('bars.details')}</summary>
        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-700/50 text-left text-xs text-slate-500">
                <th className="py-1.5">#</th>
                <th className="py-1.5">{t('bars.modelHeader')}</th>
                {benchmarks.map((b) => <th key={b.id} className="py-1.5">{b.name.slice(0, 14)}</th>)}
                <th className="py-1.5 text-right">{t('bars.average')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <tr key={row.model.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="py-1.5 text-slate-500">{i + 1}</td>
                  <td className="py-1.5 text-slate-300">{row.model.name}</td>
                  {row.segments.map((seg) => (
                    <td key={seg.benchmarkId} className="py-1.5" style={{ color: seg.percent >= 80 ? '#10b981' : seg.percent >= 50 ? '#f59e0b' : seg.percent > 0 ? '#f43f5e' : '#475569' }}>
                      {seg.percent > 0 ? `${seg.percent}%` : '—'}
                    </td>
                  ))}
                  <td className="py-1.5 text-right font-semibold text-slate-200">{row.totalPercent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
