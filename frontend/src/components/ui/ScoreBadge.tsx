// ============================================================
// ScoreBadge — kolorowy badge dla wyniku benchmarku (0-100%)
// ============================================================

import React from 'react'

export interface ScoreBadgeProps {
  score: number
  size?: 'sm' | 'md'
}

function getScoreColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
  if (score >= 60) return 'bg-emerald-500/15 text-emerald-300/90 border-emerald-500/30'
  if (score >= 50) return 'bg-amber-500/20 text-amber-300 border-amber-500/40'
  if (score >= 25) return 'bg-orange-500/20 text-orange-300 border-orange-500/40'
  if (score > 0) return 'bg-red-500/20 text-red-300 border-red-500/40'
  return 'bg-red-600/30 text-red-400 border-red-600/50'
}

const SIZES = {
  sm: 'w-8 h-7 text-xs font-bold',
  md: 'w-14 h-8 text-sm font-bold',
} as const

export const ScoreBadge: React.FC<ScoreBadgeProps> = ({ score, size = 'sm' }) => {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md border ${getScoreColor(score)} ${SIZES[size]}`}
    >
      {Math.round(score)}%
    </span>
  )
}
