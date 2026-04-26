// ============================================================
// RecentRuns — panel ostatnich uruchomień benchmarków
// ============================================================

import React from 'react'
import { useResultStore } from '@/store/resultStore'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { useTranslation } from '@/i18n'

export const RecentRuns: React.FC = () => {
  const runs = useResultStore((s) => s.runs).slice(0, 5)
  const { locale, t } = useTranslation()

  if (runs.length === 0) return null

  const formatDate = (ts: string) => {
    const d = new Date(ts)
    return d.toLocaleDateString(locale, {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <Card title={t('recent.title')} subtitle={t('recent.subtitle')}>
      <div className="space-y-3">
        {runs.map((run) => {
          return (
            <div key={run.id} className="space-y-2">
              {/* Run header */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-300">
                  {run.name || t('recent.run', { id: run.id })}
                </span>
                <span className="text-[11px] text-slate-500">{formatDate(run.started_at)}</span>
              </div>

              {/* Tags */}
              <div className="flex flex-wrap gap-1.5">
                <Badge variant={run.status === 'completed' ? 'success' : 'info'}>{run.status}</Badge>
              </div>

              {/* Quick result summary */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-500">
                  {run.finished_at ? t('recent.finished', { date: formatDate(run.finished_at) }) : t('recent.pending')}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {runs.length > 0 && (
        <p className="text-xs text-slate-600 mt-2">
          {t('recent.hint')}
        </p>
      )}
    </Card>
  )
}
