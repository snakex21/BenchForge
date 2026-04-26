import React, { useMemo, useState } from 'react'
import { ModelLogo } from '@/components/ui/ModelLogo'
import type { AIModel, Benchmark, BenchmarkResult } from '@/types'
import { getModelBenchmarkScore } from '@/utils/scoring'
import { useTranslation } from '@/i18n'

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#06b6d4', '#a855f7', '#ec4899', '#14b8a6']

interface BenchmarkRadarChartProps {
  models: AIModel[]
  benchmarks: Benchmark[]
  results: BenchmarkResult[]
}

const shortLabel = (value: string, max = 18) => value.length > max ? `${value.slice(0, max)}…` : value

export const BenchmarkRadarChart: React.FC<BenchmarkRadarChartProps> = ({ models, benchmarks, results }) => {
  const { t } = useTranslation()
  const [labelModelId, setLabelModelId] = useState<number | null>(models[0]?.id ?? null)
  const [labelBenchmarkId, setLabelBenchmarkId] = useState<number | null>(benchmarks[0]?.id ?? null)

  const chartModels = useMemo(() => models.slice(0, 8), [models])
  const radarBenchmarks = useMemo(() => benchmarks.slice(0, 16), [benchmarks])

  const rows = useMemo(() => chartModels.map((model, modelIndex) => ({
    model,
    color: COLORS[modelIndex % COLORS.length],
    scores: radarBenchmarks.map((benchmark) => {
      const score = getModelBenchmarkScore(model.id, benchmark.id, results, benchmark)
      return {
        benchmark,
        percent: score?.percent ?? 0,
        norm: score?.scoreNorm ?? 0,
        raw: score?.scoreRaw ?? '—',
      }
    }),
  })), [chartModels, radarBenchmarks, results])

  const activeLabelModelId = labelModelId && chartModels.some((model) => model.id === labelModelId)
    ? labelModelId
    : chartModels[0]?.id ?? null

  if (chartModels.length === 0 || radarBenchmarks.length === 0) {
    return <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-slate-700/60 text-sm text-slate-500">{t('radar.empty')}</div>
  }

  if (radarBenchmarks.length < 3 && chartModels.length >= 3) {
    const activeBenchmarkId = labelBenchmarkId && radarBenchmarks.some((benchmark) => benchmark.id === labelBenchmarkId)
      ? labelBenchmarkId
      : radarBenchmarks[0]?.id ?? null
    const size = 640
    const cx = size / 2
    const cy = size / 2
    const radius = 215
    const steps = [0.25, 0.5, 0.75, 1]
    const axis = chartModels.map((model, index) => {
      const angle = (2 * Math.PI * index / chartModels.length) - Math.PI / 2
      return {
        model,
        angle,
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        labelX: cx + radius * 1.18 * Math.cos(angle),
        labelY: cy + radius * 1.18 * Math.sin(angle),
      }
    })

    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/10 p-3 text-sm text-indigo-100">
          {t('radar.lowBenchmarkHint')}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">{t('radar.valueLabels')}</span>
          {radarBenchmarks.map((benchmark, index) => (
            <button
              key={benchmark.id}
              type="button"
              onClick={() => setLabelBenchmarkId(benchmark.id)}
              className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs transition ${activeBenchmarkId === benchmark.id ? 'border-indigo-400/70 bg-indigo-500/10 text-indigo-200' : 'border-slate-700/40 bg-slate-950/30 text-slate-400 hover:bg-slate-800/50'}`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
              {shortLabel(benchmark.name, 24)}
            </button>
          ))}
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-700/40 bg-[#1c1f2e] p-4">
          <svg width={size} height={size}>
            {steps.map((step) => (
              <g key={step}>
                <polygon
                  points={axis.map((point) => `${cx + radius * step * Math.cos(point.angle)},${cy + radius * step * Math.sin(point.angle)}`).join(' ')}
                  fill="none"
                  stroke={step === 0.5 ? 'rgba(148,163,184,0.28)' : 'rgba(148,163,184,0.12)'}
                  strokeWidth={step === 0.5 ? 1.5 : 1}
                />
                <text x={cx + 6} y={cy - radius * step + 4} fill="#64748b" fontSize="10">{Math.round(step * 100)}%</text>
              </g>
            ))}

            {axis.map((point) => (
              <g key={point.model.id}>
                <line x1={cx} y1={cy} x2={point.x} y2={point.y} stroke="rgba(148,163,184,0.16)" />
                <text
                  x={point.labelX}
                  y={point.labelY}
                  fill="#cbd5e1"
                  fontSize="11"
                  textAnchor={Math.cos(point.angle) < -0.1 ? 'end' : Math.cos(point.angle) > 0.1 ? 'start' : 'middle'}
                  dominantBaseline="middle"
                >
                  {shortLabel(point.model.name, 16)}
                </text>
              </g>
            ))}

            {radarBenchmarks.map((benchmark, benchmarkIndex) => {
              const color = COLORS[benchmarkIndex % COLORS.length]
              const isActive = benchmark.id === activeBenchmarkId
              const points = axis.map((point) => {
                const score = getModelBenchmarkScore(point.model.id, benchmark.id, results, benchmark)
                const norm = Math.max(0, Math.min(score?.scoreNorm ?? 0, 1))
                return {
                  x: cx + radius * norm * Math.cos(point.angle),
                  y: cy + radius * norm * Math.sin(point.angle),
                  percent: score?.percent ?? 0,
                  angle: point.angle,
                  model: point.model,
                }
              })

              return (
                <g key={benchmark.id}>
                  <polygon
                    points={points.map((point) => `${point.x},${point.y}`).join(' ')}
                    fill={color}
                    opacity={isActive ? 0.28 : 0.12}
                    stroke={color}
                    strokeWidth={isActive ? 3 : 1.6}
                  />
                  {points.map((point) => (
                    <g key={point.model.id}>
                      <circle cx={point.x} cy={point.y} r={isActive ? 4 : 2.5} fill={color} stroke="#1c1f2e" strokeWidth={1.5}>
                        <title>{`${benchmark.name} · ${point.model.name}: ${point.percent}%`}</title>
                      </circle>
                      {isActive && (
                        <text
                          x={cx + radius * 1.04 * Math.cos(point.angle)}
                          y={cy + radius * 1.04 * Math.sin(point.angle)}
                          fill={color}
                          fontSize="10"
                          textAnchor="middle"
                          fontWeight="700"
                        >
                          {point.percent}%
                        </text>
                      )}
                    </g>
                  ))}
                </g>
              )
            })}
          </svg>
        </div>
      </div>
    )
  }

  if (radarBenchmarks.length < 3) {
    return (
      <div className="space-y-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
        <div>
          <p className="text-sm font-semibold text-amber-200">{t('radar.requiresThree')}</p>
          <p className="mt-1 text-xs text-amber-200/70">{t('radar.fallbackHint')}</p>
        </div>
        <div className="space-y-3">
          {radarBenchmarks.map((benchmark) => (
            <div key={benchmark.id} className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3">
              <p className="mb-2 text-sm font-semibold text-slate-200">{benchmark.name}</p>
              <div className="space-y-2">
                {chartModels.map((model, index) => {
                  const score = getModelBenchmarkScore(model.id, benchmark.id, results, benchmark)
                  const percent = score?.percent ?? 0
                  return (
                    <div key={model.id} className="grid grid-cols-[minmax(8rem,0.35fr)_1fr_auto] items-center gap-3 text-xs">
                      <span className="flex min-w-0 items-center gap-2 text-slate-300"><ModelLogo model={model} size="sm" /><span className="truncate">{model.name}</span></span>
                      <span className="h-2.5 overflow-hidden rounded-full bg-slate-800"><span className="block h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: COLORS[index % COLORS.length] }} /></span>
                      <span className="w-12 text-right text-slate-300">{percent}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const size = 640
  const cx = size / 2
  const cy = size / 2
  const radius = 215
  const steps = [0.25, 0.5, 0.75, 1]
  const axis = radarBenchmarks.map((benchmark, index) => {
    const angle = (2 * Math.PI * index / radarBenchmarks.length) - Math.PI / 2
    return {
      benchmark,
      angle,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      labelX: cx + radius * 1.18 * Math.cos(angle),
      labelY: cy + radius * 1.18 * Math.sin(angle),
    }
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">{t('radar.valueLabels')}</span>
        {chartModels.map((model, index) => (
          <button
            key={model.id}
            type="button"
            onClick={() => setLabelModelId(model.id)}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs transition ${activeLabelModelId === model.id ? 'border-indigo-400/70 bg-indigo-500/10 text-indigo-200' : 'border-slate-700/40 bg-slate-950/30 text-slate-400 hover:bg-slate-800/50'}`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
            <ModelLogo model={model} size="sm" />
            {shortLabel(model.name, 20)}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-700/40 bg-[#1c1f2e] p-4">
        <svg width={size} height={size}>
          {steps.map((step) => (
            <g key={step}>
              <polygon
                points={axis.map((point) => `${cx + radius * step * Math.cos(point.angle)},${cy + radius * step * Math.sin(point.angle)}`).join(' ')}
                fill="none"
                stroke={step === 0.5 ? 'rgba(148,163,184,0.28)' : 'rgba(148,163,184,0.12)'}
                strokeWidth={step === 0.5 ? 1.5 : 1}
              />
              <text x={cx + 6} y={cy - radius * step + 4} fill="#64748b" fontSize="10">{Math.round(step * 100)}%</text>
            </g>
          ))}

          {axis.map((point) => (
            <g key={point.benchmark.id}>
              <line x1={cx} y1={cy} x2={point.x} y2={point.y} stroke="rgba(148,163,184,0.16)" />
              <text
                x={point.labelX}
                y={point.labelY}
                fill="#cbd5e1"
                fontSize="11"
                textAnchor={Math.cos(point.angle) < -0.1 ? 'end' : Math.cos(point.angle) > 0.1 ? 'start' : 'middle'}
                dominantBaseline="middle"
              >
                {shortLabel(point.benchmark.name, 16)}
              </text>
            </g>
          ))}

          {rows.map((row) => {
            const points = row.scores.map((score, index) => {
              const point = axis[index]
              const norm = Math.max(0, Math.min(score.norm, 1))
              return {
                x: cx + radius * norm * Math.cos(point.angle),
                y: cy + radius * norm * Math.sin(point.angle),
                percent: score.percent,
                angle: point.angle,
              }
            })
            const isLabelModel = row.model.id === activeLabelModelId

            return (
              <g key={row.model.id}>
                <polygon
                  points={points.map((point) => `${point.x},${point.y}`).join(' ')}
                  fill={row.color}
                  opacity={isLabelModel ? 0.28 : 0.12}
                  stroke={row.color}
                  strokeWidth={isLabelModel ? 3 : 1.6}
                />
                {points.map((point, index) => (
                  <g key={index}>
                    <circle cx={point.x} cy={point.y} r={isLabelModel ? 4 : 2.5} fill={row.color} stroke="#1c1f2e" strokeWidth={1.5}>
                      <title>{`${row.model.name} · ${axis[index].benchmark.name}: ${point.percent}%`}</title>
                    </circle>
                    {isLabelModel && (
                      <text
                        x={cx + radius * 1.04 * Math.cos(point.angle)}
                        y={cy + radius * 1.04 * Math.sin(point.angle)}
                        fill={row.color}
                        fontSize="10"
                        textAnchor="middle"
                        fontWeight="700"
                      >
                        {point.percent}%
                      </text>
                    )}
                  </g>
                ))}
              </g>
            )
          })}
        </svg>
      </div>

      <details className="rounded-xl border border-slate-700/40 bg-slate-950/30">
        <summary className="cursor-pointer px-4 py-2 text-sm text-slate-400">{t('radar.valueTable')}</summary>
        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-700/50 text-left text-xs text-slate-500">
                <th className="py-1.5">Model</th>
                {radarBenchmarks.map((benchmark) => <th key={benchmark.id} className="py-1.5">{shortLabel(benchmark.name, 14)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.model.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="py-1.5 text-slate-300">{row.model.name}</td>
                  {row.scores.map((score) => <td key={score.benchmark.id} className="py-1.5 text-slate-400">{score.percent}%</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
