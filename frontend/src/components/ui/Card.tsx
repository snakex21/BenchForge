// ============================================================
// Card — podstawa każdej sekcji UI
// ============================================================

import React from 'react'

export interface CardProps {
  children: React.ReactNode
  title?: string
  subtitle?: string
  className?: string
  padding?: boolean
}

export const Card: React.FC<CardProps> = React.memo(({
  children,
  title,
  subtitle,
  className = '',
  padding = true,
}) => {
  return (
    <div
      className={`rounded-xl border border-slate-700/50 overflow-hidden ${className}`}
      style={{ backgroundColor: 'var(--surface-1)', borderColor: 'var(--border-main)' }}
    >
      {(title || subtitle) && (
        <div className="min-w-0 px-4 py-3 border-b border-slate-700/30">
          {title && <p className="truncate text-sm font-semibold text-slate-200">{title}</p>}
          {subtitle && (
            <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
          )}
        </div>
      )}
      <div className={padding ? 'p-4' : ''}>{children}</div>
    </div>
  )
})

Card.displayName = 'Card'
