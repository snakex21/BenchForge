// ============================================================
// Badge — znacznik wyniku benchmarku (0-5 lub tak/nie)
// ============================================================

import React from 'react'

export interface BadgeProps {
  /** Typ badge'a */
  variant?: 'info' | 'success' | 'warning' | 'danger' | 'neutral'
  /** Treść */
  children: React.ReactNode
  /** Dodatkowe klasy CSS */
  className?: string
}

const VARIANT_CLASSES: Record<string, string> = {
  info: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  success: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  warning: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  danger: 'bg-red-500/20 text-red-300 border-red-500/30',
  neutral: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
}

export const Badge: React.FC<BadgeProps> = ({
  variant = 'neutral',
  children,
  className = '',
}) => {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </span>
  )
}
