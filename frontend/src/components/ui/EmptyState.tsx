// ============================================================
// EmptyState — stan pustej sekcji
// ============================================================

import React from 'react'

export interface EmptyStateProps {
  icon?: string
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
}

const ICONS: Record<string, string> = {
  search: '🔍',
  plus: '➕',
  chart: '📊',
  folder: '📁',
  default: '📭',
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon = 'default',
  title,
  description,
  actionLabel,
  onAction,
}) => {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="text-4xl mb-3">{ICONS[icon] ?? ICONS.default}</span>
      <h3 className="text-base font-semibold text-slate-300 mb-1">{title}</h3>
      <p className="text-sm text-slate-500 max-w-xs mb-4">{description}</p>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
