import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { OutputViewer } from './OutputViewer'
import { ScoreInput } from './ScoreInput'
import type { EvaluationRubricItem, OutputType, ScoreType } from '@/types'
import { verifyMazePath, type MazeVerifyResult } from '@/utils/mazeVerifier'
import { useTranslation } from '@/i18n'

interface ManualPromptDialogProps {
  prompt: string
  scoreType: ScoreType
  outputType?: OutputType
  initialResponse?: string
  referenceImage?: string | null
  passCondition?: string | null
  evaluationChecklist?: string[]
  evaluationRubric?: EvaluationRubricItem[]
  onSubmit: (response: string, score: string, rubricReport?: unknown) => void
  onCancel: () => void
}

export const ManualPromptDialog: React.FC<ManualPromptDialogProps> = ({ prompt, scoreType, outputType = 'text', initialResponse = '', referenceImage, passCondition, evaluationChecklist = [], evaluationRubric = [], onSubmit, onCancel }) => {
  const { t } = useTranslation()
  const [response, setResponse] = useState(initialResponse)
  const [score, setScore] = useState('')
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(outputType !== 'text')
  const [checklistValues, setChecklistValues] = useState<boolean[]>(() => evaluationChecklist.map(() => false))
  const [rubricValues, setRubricValues] = useState<Record<string, number>>({})
  const [rubricComment, setRubricComment] = useState('')
  const [mazeVerifyResult, setMazeVerifyResult] = useState<MazeVerifyResult | null>(null)

  const suggestedScore = useMemo(() => {
    if (evaluationRubric.length > 0) {
      const max = evaluationRubric.reduce((sum, item) => sum + (Number(item.points) || 0), 0)
      const earned = evaluationRubric.reduce((sum, item, index) => sum + Math.max(0, Math.min(Number(item.points) || 0, Number(rubricValues[item.id || String(index)] || 0))), 0)
      if (scoreType === 'boolean') return earned >= max / 2 ? 'tak' : 'nie'
      return String(Math.round((earned / Math.max(1, max)) * 100))
    }
    if (!evaluationChecklist.length) return ''
    const yesCount = checklistValues.filter(Boolean).length
    const ratio = yesCount / evaluationChecklist.length
    if (scoreType === 'boolean') {
      return ratio > 0.5 ? 'tak' : 'nie'
    }
    return String(Math.max(1, Math.round(ratio * 5)))
  }, [checklistValues, evaluationChecklist.length, evaluationRubric, rubricValues, scoreType])

  const rubricReport = useMemo(() => {
    if (evaluationRubric.length === 0) return null
    const items = evaluationRubric.map((item, index) => {
      const key = item.id || String(index)
      const max = Number(item.points) || 0
      const value = Math.max(0, Math.min(max, Number(rubricValues[key] || 0)))
      return { ...item, id: key, awarded: value, max }
    })
    const total = items.reduce((sum, item) => sum + item.max, 0)
    const awarded = items.reduce((sum, item) => sum + item.awarded, 0)
    return { type: 'manual_rubric', awarded, total, percent: Math.round((awarded / Math.max(1, total)) * 100), comment: rubricComment, items }
  }, [evaluationRubric, rubricComment, rubricValues])

  useEffect(() => {
    if (suggestedScore) setScore(suggestedScore)
  }, [suggestedScore])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(prompt)
    setCopyStatus(t('manual.promptCopied'))
  }

  const handleCopyImage = async () => {
    if (!referenceImage) return
    const bytes = Uint8Array.from(atob(referenceImage), (char) => char.charCodeAt(0))
    const blob = new Blob([bytes], { type: 'image/png' })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    setCopyStatus(t('manual.imageCopied'))
  }

  const handleDownloadImage = () => {
    if (!referenceImage) return
    const link = document.createElement('a')
    link.download = 'maze.png'
    link.href = `data:image/png;base64,${referenceImage}`
    link.click()
  }

  const handleVerifyMaze = async () => {
    if (!referenceImage) return
    const parsed = JSON.parse(passCondition || '{}')
    const result = await verifyMazePath(referenceImage, response, parsed.start, parsed.end, parsed.tolerance || 5)
    setMazeVerifyResult(result)
    setScore(result.passed ? 'tak' : 'nie')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-3xl rounded-2xl border border-slate-700/60 bg-[#161822] p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">{t('manual.title')}</h3>
            <p className="text-sm text-slate-500">{outputType === 'maze' ? t('manual.descriptionMaze') : outputType === 'text' ? t('manual.descriptionText') : t('manual.descriptionVisual')}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onCancel}>{t('common.close')}</Button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Prompt</label>
            <textarea readOnly value={prompt} rows={8} className="w-full rounded-lg border border-slate-600/50 bg-[#0f1117] px-3 py-2 text-sm text-slate-200 focus:outline-none" />
          </div>

          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>{t('manual.copyPrompt')}</Button>
            {copyStatus && <span className="text-xs text-slate-500">{copyStatus}</span>}
          </div>

          {outputType === 'maze' ? (
            <div className="space-y-3">
              {referenceImage && <img src={`data:image/png;base64,${referenceImage}`} className="max-h-48 rounded border border-slate-700 bg-white" />}
              <p className="text-xs text-slate-400">{t('manual.mazeHelp')}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => void handleCopyImage()}>{t('manual.copyImage')}</Button>
                <Button variant="ghost" size="sm" onClick={handleDownloadImage}>{t('manual.downloadImage')}</Button>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">{t('manual.modelJsonAnswer')}</label>
                <textarea value={response} onChange={(event) => setResponse(event.target.value)} rows={8} placeholder='{ "path": [[x1,y1], [x2,y2]] }' className="w-full rounded-lg border border-slate-600/50 bg-[#0f1117] px-3 py-2 font-mono text-xs text-slate-200" />
              </div>
              <Button variant="secondary" size="sm" onClick={() => void handleVerifyMaze()} disabled={!response.trim() || !referenceImage}>{t('manual.verifyPath')}</Button>
              {referenceImage && mazeVerifyResult && <OutputViewer content={response} outputType="maze" imageBase64={referenceImage} verifyResult={mazeVerifyResult} />}
            </div>
          ) : outputType === 'text' ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('common.modelAnswer')}</label>
              <textarea value={response} onChange={(event) => setResponse(event.target.value)} rows={8} placeholder={t('manual.answerPlaceholder')} className="w-full rounded-lg border border-slate-600/50 bg-[#0f1117] px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500/50 focus:outline-none" />
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">{t('manual.generatedCode')}</label>
                <textarea readOnly value={response} rows={8} className="w-full rounded-lg border border-slate-600/50 bg-[#0f1117] px-3 py-2 font-mono text-xs text-slate-200 focus:outline-none" />
              </div>
              <Button variant="secondary" size="sm" onClick={() => setShowPreview((current) => !current)}>{showPreview ? t('manual.hidePreview') : t('common.preview')}</Button>
              {showPreview && <OutputViewer content={response} outputType={outputType} />}
            </div>
          )}

          {evaluationChecklist.length > 0 && (
            <div className="space-y-3 rounded-lg border border-slate-700/40 bg-[#0f1117] p-3">
              <p className="text-xs font-medium text-slate-400">{t('common.evaluationChecklist')}</p>
              {evaluationChecklist.map((question, index) => (
                <label key={`${question}-${index}`} className="flex items-center gap-3 text-sm text-slate-300">
                  <input type="checkbox" checked={checklistValues[index] || false} onChange={(event) => setChecklistValues((current) => current.map((value, valueIndex) => valueIndex === index ? event.target.checked : value))} />
                  <span>{question}</span>
                </label>
              ))}
              {suggestedScore && <p className="text-xs text-slate-500">{t('manual.suggestedScore')} <strong>{suggestedScore.toUpperCase()}</strong></p>}
            </div>
          )}

          {evaluationRubric.length > 0 && (
            <div className="space-y-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-indigo-200">{t('common.evaluationRubric')}</p>
                {rubricReport && <span className="text-xs text-slate-400">{rubricReport.awarded}/{rubricReport.total} · {rubricReport.percent}%</span>}
              </div>
              {evaluationRubric.map((item, index) => {
                const key = item.id || String(index)
                const max = Number(item.points) || 0
                const current = Number(rubricValues[key] || 0)
                if ((item.type || 'scale') === 'checkbox') {
                  return <label key={key} className="flex items-center justify-between gap-3 rounded-lg border border-slate-700/40 bg-slate-950/40 p-2 text-sm text-slate-300"><span>{item.label} <span className="text-xs text-slate-500">({max})</span></span><input type="checkbox" checked={current > 0} onChange={(event) => setRubricValues((values) => ({ ...values, [key]: event.target.checked ? max : 0 }))} /></label>
                }
                return <label key={key} className="block rounded-lg border border-slate-700/40 bg-slate-950/40 p-2 text-sm text-slate-300"><span>{item.label} <span className="text-xs text-slate-500">0–{max}</span></span><input type="number" min={0} max={max} value={current} onChange={(event) => setRubricValues((values) => ({ ...values, [key]: Math.max(0, Math.min(max, Number(event.target.value) || 0)) }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200" /></label>
              })}
              <textarea value={rubricComment} onChange={(event) => setRubricComment(event.target.value)} placeholder="Komentarz oceniającego..." className="h-20 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
            </div>
          )}

          <div>
            <label className="mb-2 block text-xs font-medium text-slate-400">{t('manual.scoreResult')}</label>
            <ScoreInput scoreType={scoreType} value={score} onChange={setScore} />
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
            <Button onClick={() => onSubmit(response, score, rubricReport || undefined)} disabled={!response.trim() || !score}>{t('manual.submitAnswer')}</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
