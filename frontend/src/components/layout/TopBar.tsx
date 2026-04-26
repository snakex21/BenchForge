// ============================================================
// TopBar — górny pasek z akcjami i tytułem widoku
// ============================================================

import React, { useEffect, useState } from 'react'
import { useUIStore } from '@/store/uiStore'
import { useTranslation, type TranslationKey } from '@/i18n'
import type { ActiveView } from '@/types'
import { Button } from '../ui/Button'

export interface TopBarProps {
  title: string
  actions?: React.ReactNode
}

const VIEW_TITLE_KEYS: Record<ActiveView, TranslationKey> = {
  arena: 'topbar.arena',
  runner: 'topbar.runner',
  models: 'topbar.models',
  benchmarks: 'topbar.benchmarks',
  results: 'topbar.results',
  stats: 'topbar.stats',
  settings: 'topbar.settings',
}

export const TopBar: React.FC<TopBarProps> = ({ title, actions }) => {
  const activeView = useUIStore((s) => s.activeView)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)
  const { t } = useTranslation()
  const [lmStudioOnline, setLmStudioOnline] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const scan = await window.db?.scanModels()
        if (!cancelled) setLmStudioOnline(Boolean(scan?.lmstudio?.length))
      } catch {
        if (!cancelled) setLmStudioOnline(false)
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 15000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  // Jeśli nie podano customowego tytułu, użyj domyślnego z aktywnego widoku
  const displayTitle = title || t(VIEW_TITLE_KEYS[activeView])

  return (
    <header className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-4 border-b border-slate-700/40 backdrop-blur-sm" style={{ backgroundColor: 'color-mix(in srgb, var(--surface-2) 86%, transparent)', borderColor: 'var(--border-main)' }}>
      {/* Title */}
      <div className="flex items-center gap-3 min-w-0">
        <h1 className="text-sm font-semibold text-slate-200 truncate">
          {displayTitle}
        </h1>
      </div>

      {/* Actions + toggle panel */}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <span className={`rounded-full border px-2 py-1 text-[11px] ${lmStudioOnline ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : lmStudioOnline === false ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-slate-600 bg-slate-800 text-slate-400'}`}>
          LMStudio: {lmStudioOnline ? 'online' : lmStudioOnline === false ? 'offline' : '...' }
        </span>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRightPanelOpen(!rightPanelOpen)}
          className={rightPanelOpen ? 'text-indigo-400' : ''}
          aria-label={rightPanelOpen ? t('topbar.hideDetails') : t('topbar.showDetails')}
        >
          {rightPanelOpen ? `◀ ${t('topbar.panel')}` : `▶ ${t('topbar.panel')}`}
        </Button>
      </div>
    </header>
  )
}
