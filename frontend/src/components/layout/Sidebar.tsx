// ============================================================
// Sidebar — lewy panel nawigacji
// ============================================================

import React from 'react'
import { useUIStore } from '@/store/uiStore'
import { useTranslation, type TranslationKey } from '@/i18n'
import type { ActiveView } from '@/types'

interface NavItem {
  id: ActiveView
  labelKey: TranslationKey
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { id: 'arena', labelKey: 'nav.arena', icon: '🏟️' },
  { id: 'runner', labelKey: 'nav.runner', icon: '▶' },
  { id: 'models', labelKey: 'nav.models', icon: '🤖' },
  { id: 'benchmarks', labelKey: 'nav.benchmarks', icon: '🧪' },
  { id: 'results', labelKey: 'nav.results', icon: '📋' },
  { id: 'stats', labelKey: 'nav.stats', icon: '📊' },
  { id: 'settings', labelKey: 'nav.settings', icon: '⚙️' },
]

export const Sidebar: React.FC = () => {
  const activeView = useUIStore((s) => s.activeView)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const { t } = useTranslation()

  return (
    <aside
      className={`
        flex flex-col border-r border-slate-700/40
        transition-all duration-200 ease-out
        ${sidebarCollapsed ? 'w-[56px]' : 'w-[56px] md:w-[220px]'}
      `}
      style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border-main)' }}
    >
      {/* Logo / Brand */}
      <div className="h-12 flex items-center px-3 border-b border-slate-700/40">
        <button
          onClick={toggleSidebar}
          className={`flex items-center gap-2 w-full hover:bg-slate-700/30 rounded-lg transition-colors p-1.5`}
          title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          <span className="text-lg leading-none">🏗️</span>
          {!sidebarCollapsed && (
            <span className="hidden text-sm font-bold text-slate-200 tracking-wide truncate md:inline">
              BenchForge
            </span>
          )}
        </button>
      </div>

      {/* Navigation items */}
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const isActive = activeView === item.id
          const label = t(item.labelKey)
          return (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={`
                w-full flex items-center gap-3 rounded-lg transition-all duration-150
                ${sidebarCollapsed ? 'justify-center px-2' : 'justify-center px-2 md:justify-start md:px-3'}
                py-2 text-sm font-medium
                ${
                  isActive
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/20 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/30'
                }
              `}
              title={sidebarCollapsed ? label : undefined}
            >
              <span className="text-base leading-none">{item.icon}</span>
              {!sidebarCollapsed && <span className="hidden md:inline">{label}</span>}
            </button>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-slate-700/40">
        {!sidebarCollapsed ? (
          <p className="hidden text-[10px] text-slate-600 leading-tight md:block">
            BenchForge<br />v1.0.0
          </p>
        ) : (
          <div className="w-2 h-2 rounded-full bg-emerald-500/40 mx-auto" />
        )}
      </div>
    </aside>
  )
}
