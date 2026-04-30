// ============================================================
// BenchmarkMatrix — główna tabela wyników
// Modele w wierszach, benchmarki w kolumnach
// ============================================================

import React from 'react'
import { useUIStore } from '@/store/uiStore'
import { useBenchmarkStore } from '@/store/benchmarkStore'
import { useModelStore } from '@/store/modelStore'
import { useResultStore } from '@/store/resultStore'
import { Badge } from '../ui/Badge'
import { ModelLogo } from '../ui/ModelLogo'
import { getModelBenchmarkScore } from '@/utils/scoring'
import { useTranslation, type TranslationKey } from '@/i18n'
import type { Benchmark } from '@/types'

interface BenchmarkMatrixProps {
  benchmarksOverride?: Benchmark[]
  onModelOpen?: (modelId: number) => void
}

const CATEGORY_KEYS: Record<string, TranslationKey> = {
  Logika: 'benchmarks.categoryLogika',
  Wiedza: 'benchmarks.categoryWiedza',
  Kod: 'benchmarks.categoryKod',
  Kreatywność: 'benchmarks.categoryKreatywnosc',
  Wizja: 'benchmarks.categoryWizja',
  Inne: 'benchmarks.categoryInne',
}

export const BenchmarkMatrix: React.FC<BenchmarkMatrixProps> = ({ benchmarksOverride, onModelOpen }) => {
  const models = useModelStore((s) => s.models)
  const storeBenchmarks = useBenchmarkStore((s) => s.benchmarks)
  const results = useResultStore((s) => s.results)
  const selectedModelId = useUIStore((s) => s.selectedModelId)
  const selectModel = useUIStore((s) => s.selectModel)
  const selectBenchmark = useUIStore((s) => s.selectBenchmark)
  const { t } = useTranslation()
  const benchmarks = benchmarksOverride || storeBenchmarks

  const getBenchmarkLabel = (name: string) => (name.length > 14 ? `${name.slice(0, 14)}…` : name)

  // Category label → color
  const getCategoryBadge = (cat: string) => {
    return <Badge variant="neutral">{CATEGORY_KEYS[cat] ? t(CATEGORY_KEYS[cat]) : cat}</Badge>
  }

  if (models.length === 0 || benchmarks.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-slate-500 text-sm">
          {models.length === 0 && benchmarks.length === 0
            ? t('matrix.emptyBoth')
            : models.length === 0
              ? t('matrix.emptyModels')
              : t('matrix.emptyBenchmarks')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="flex items-center gap-3 text-xs text-slate-500 mb-2">
        <span>{t('matrix.legend')}</span>
        <span className="text-red-400 font-medium">{t('matrix.bad')}</span>
        <span className="text-slate-600 mx-1">→</span>
        <span className="text-emerald-400 font-medium">{t('matrix.good')}</span>
      </div>

      {/* Matrix table */}
      <div className="overflow-x-auto rounded-xl border border-slate-700/40 bg-[#1c1f2e]">
        <table className="w-full min-w-[800px]">
          <thead>
            <tr className="border-b border-slate-700/50">
              {/* Row number column */}
              <th className="sticky left-0 z-10 bg-[#1c1f2e] px-2 py-3 text-center text-xs font-semibold text-slate-600 w-8">
                #
              </th>
              <th className="sticky left-0 z-10 bg-[#1c1f2e] px-4 py-3 text-left text-xs font-semibold text-slate-400 min-w-[160px]">
                {t('matrix.modelHeader')}
              </th>
              {benchmarks.map((bm) => (
                <th
                  key={bm.id}
                  className={`px-3 py-3 text-center min-w-[120px] cursor-pointer transition-colors group ${!bm.prompt_template?.trim() ? 'bg-slate-800/40' : 'hover:bg-slate-700/20'}`}
                  onClick={() => selectBenchmark(bm.id)}
                >
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs font-semibold text-slate-300 group-hover:text-indigo-300 transition-colors">
                      {bm.prompt_template?.trim() ? getBenchmarkLabel(bm.name) : `⚠️ ${getBenchmarkLabel(bm.name)}`}
                    </span>
                    <span className="text-[10px]">{getCategoryBadge(bm.category)}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {models.map((model, index) => (
              <tr
                key={model.id}
                className={`border-b border-slate-700/30 transition-colors cursor-pointer
                  ${selectedModelId === model.id
                    ? 'bg-indigo-600/10'
                    : 'hover:bg-slate-700/20'
                  }`}
                onClick={() => {
                  selectModel(model.id)
                  onModelOpen?.(model.id)
                }}
              >
                {/* Row number */}
                <td className="sticky left-0 z-10 bg-[#1c1f2e] px-2 py-3 text-center text-xs text-slate-600">
                  {index + 1}
                </td>
                {/* Model cell */}
                <td className="sticky left-0 z-10 bg-[#1c1f2e] px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <ModelLogo model={model} size="sm" />
                    <div className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-200">
                        {model.name}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {model.provider}
                      </span>
                    </div>
                  </div>
                </td>

                {/* Score cells */}
                {benchmarks.map((bm) => {
                  const score = getModelBenchmarkScore(model.id, bm.id, results, bm)
                  return (
                    <td
                      key={bm.id}
                      className={`px-3 py-3 text-center ${!bm.prompt_template?.trim() ? 'bg-slate-800/40' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        selectBenchmark(bm.id)
                      }}
                    >
                      {!bm.prompt_template?.trim() ? (
                        <span className="text-slate-500 text-xs">⚠️</span>
                      ) : score ? (
                        <Badge
                          variant={score.percent >= 50 ? 'success' : 'danger'}
                        >
                          {score.scoreRaw.includes('/') ? score.scoreRaw : `${score.percent}%`}
                        </Badge>
                      ) : (
                        <span className="text-slate-700 text-sm">—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Action hint */}
      <p className="text-xs text-slate-600 mt-2">
        {t('matrix.hintBenchmark')}
        {' '}{t('matrix.hintModel')}
      </p>
    </div>
  )
}
