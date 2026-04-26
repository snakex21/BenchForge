import React from 'react'
import { Button } from '../ui/Button'
import type { ScoreType } from '@/types'
import { useTranslation } from '@/i18n'

interface ScoreInputProps {
  scoreType: ScoreType
  value: string
  onChange: (value: string) => void
}

export const ScoreInput: React.FC<ScoreInputProps> = ({ scoreType, value, onChange }) => {
  const { t } = useTranslation()
  if (scoreType === 'boolean') {
    return (
      <div className="flex gap-2">
        <Button variant={value === 'tak' ? 'primary' : 'secondary'} size="sm" onClick={() => onChange('tak')}>
          {t('common.yes')}
        </Button>
        <Button variant={value === 'nie' ? 'primary' : 'secondary'} size="sm" onClick={() => onChange('nie')}>
          {t('common.no')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min="0"
        max="100"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0–100"
        className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 text-center outline-none focus:border-indigo-500/60"
      />
      <span className="text-sm text-slate-400">%</span>
    </div>
  )
}
