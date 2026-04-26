import React, { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ModelLogo } from '@/components/ui/ModelLogo'
import { MarkdownViewer } from '@/components/benchmark/OutputViewer'
import type { AIModel, Benchmark, BenchmarkResult } from '@/types'
import { getModelBenchmarkScore, getModelSummary } from '@/utils/scoring'
import { getLocale, useTranslation, type Language } from '@/i18n'

interface ModelResultsModalProps {
  model: AIModel
  benchmarks: Benchmark[]
  results: BenchmarkResult[]
  onClose: () => void
  onOpenResults: () => void
  onRerun: (modelId: number, benchmarkId: number) => void
}

const formatDate = (value?: string | null, language: Language = 'pl') => {
  if (!value) return '—'
  const locale = getLocale(language)
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (match) {
    const [, year, month, day, hour, minute, second = '0'] = match
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)))
    return date.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  return new Date(value).toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const getLatestResult = (modelId: number, benchmarkId: number, results: BenchmarkResult[]) => {
  const matching = results
    .filter((result) => result.model_id === modelId && result.benchmark_id === benchmarkId)
    .sort((a, b) => b.id - a.id)
  return matching.find((result) => result.task_id == null) || matching[0] || null
}

export const ModelResultsModal: React.FC<ModelResultsModalProps> = ({ model, benchmarks, results, onClose, onOpenResults, onRerun }) => {
  const { language, t } = useTranslation()
  const [selectedBenchmarkId, setSelectedBenchmarkId] = useState<number | null>(benchmarks[0]?.id ?? null)
  const summary = useMemo(() => getModelSummary(model.id, results, benchmarks), [benchmarks, model.id, results])

  const rows = useMemo(() => benchmarks.map((benchmark) => {
    const score = getModelBenchmarkScore(model.id, benchmark.id, results, benchmark)
    const latest = getLatestResult(model.id, benchmark.id, results)
    return { benchmark, score, latest }
  }), [benchmarks, model.id, results])

  const selectedRow = rows.find((row) => row.benchmark.id === selectedBenchmarkId) || rows[0] || null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-slate-700/60 bg-[#1b1e2b] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-700/50 p-3 sm:p-5">
          <div className="flex min-w-0 items-center gap-3">
            <ModelLogo model={model} size="md" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-300">{t('modelModal.title')}</p>
              <h3 className="truncate text-xl font-semibold text-slate-100">{model.name}</h3>
              <p className="mt-1 text-sm text-slate-500">{model.provider || model.mode}{model.model_id ? ` · ${model.model_id}` : ''}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={summary.percent >= 50 ? 'success' : 'danger'}>{summary.percent}%</Badge>
            <Badge variant="neutral">{benchmarks.length} {t('common.benchmarks').toLowerCase()}</Badge>
            <Button variant="secondary" size="sm" onClick={onOpenResults}>{t('modelModal.openResults')}</Button>
            <Button variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</Button>
          </div>
        </div>

        <div className="grid max-h-[calc(92vh-96px)] min-h-0 gap-4 overflow-auto p-3 sm:p-5 xl:grid-cols-[380px_minmax(0,1fr)]">
          <aside className="space-y-2">
            {rows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700/60 p-4 text-sm text-slate-500">{t('modelModal.noBenchmarks')}</div>
            ) : rows.map((row) => {
              const selected = selectedRow?.benchmark.id === row.benchmark.id
              return (
                <button
                  key={row.benchmark.id}
                  type="button"
                  className={`w-full rounded-xl border p-3 text-left transition ${selected ? 'border-indigo-400/70 bg-indigo-500/15' : 'border-slate-700/40 bg-slate-950/30 hover:bg-slate-800/50'}`}
                  onClick={() => setSelectedBenchmarkId(row.benchmark.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-200">{row.benchmark.name}</p>
                      <p className="mt-1 text-xs text-slate-500">{row.benchmark.category} · {row.benchmark.output_type}</p>
                    </div>
                    {row.score ? <Badge variant={row.score.percent >= 50 ? 'success' : 'danger'}>{row.score.percent}%</Badge> : <Badge variant="neutral">—</Badge>}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {row.score?.scoreRaw && <span>Raw: {row.score.scoreRaw}</span>}
                    {row.latest?.run_at && <span>{formatDate(row.latest.run_at, language)}</span>}
                  </div>
                </button>
              )
            })}
          </aside>

          <section className="min-w-0 space-y-4 rounded-2xl border border-slate-700/50 bg-slate-950/30 p-4 shadow-inner shadow-black/10">
            {!selectedRow ? (
              <div className="flex h-72 items-center justify-center text-sm text-slate-500">{t('runner.chooseBenchmarks')}</div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-4">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-indigo-300">{t('modelModal.currentBenchmark')}</p>
                    <h4 className="mt-1 truncate text-lg font-semibold text-slate-100">{selectedRow.benchmark.name}</h4>
                    <p className="mt-1 text-sm text-slate-500">{selectedRow.benchmark.category} · {formatDate(selectedRow.latest?.run_at, language)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedRow.score ? <Badge variant={selectedRow.score.percent >= 50 ? 'success' : 'danger'}>{selectedRow.score.percent}%</Badge> : <Badge variant="neutral">{t('modelModal.noResult')}</Badge>}
                    {selectedRow.score?.scoreRaw && <Badge variant="neutral">{selectedRow.score.scoreRaw}</Badge>}
                    <Button variant="secondary" size="sm" onClick={() => onRerun(model.id, selectedRow.benchmark.id)}>{t('results.rerun')}</Button>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-700/40 bg-[#101322] p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('modelModal.benchmarkPrompt')}</p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-sm text-slate-200">{selectedRow.benchmark.prompt_template || t('common.noPrompt')}</pre>
                </div>

                <div className="rounded-xl border border-slate-700/40 bg-slate-950 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('modelModal.lastAnswer')}</p>
                    <span className="text-xs text-slate-500">{t('common.resultId', { id: selectedRow.latest?.id ?? '—' })}</span>
                  </div>
                  <div className="min-h-64 rounded-lg bg-[#070b17] p-4">
                    <MarkdownViewer content={selectedRow.latest?.notes || t('modelModal.noAnswer')} />
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
