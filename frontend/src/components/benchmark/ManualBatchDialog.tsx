import React, { useMemo, useState } from 'react'
import { useTranslation, type TranslationKey } from '@/i18n'
import type { EvaluationRubricItem, OutputType, ScoreType } from '@/types'
import { Button } from '../ui/Button'

export interface ManualBatchTaskInput {
  taskId: number | null
  title: string
  prompt: string
  scoreType: ScoreType
  outputType: OutputType
  passCondition?: string | null
  expectedAnswer?: string | null
  evaluationChecklist?: string[]
  evaluationRubric?: EvaluationRubricItem[]
  referenceImage?: string | null
}

export interface ManualBatchEntry {
  taskId: number | null
  response: string
  score?: string | null
}

interface ManualBatchDialogProps {
  benchmarkName: string
  tasks: ManualBatchTaskInput[]
  batchNumber: number
  totalBatches: number
  largeRepoWarning?: boolean
  onSubmit: (entries: ManualBatchEntry[]) => void
  onCancel: () => void
}

const taskKey = (taskId: number | null) => String(taskId ?? 0)

const parseAttributes = (source: string) => {
  const attrs: Record<string, string> = {}
  const regex = /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(source))) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attrs
}

const coerceTaskId = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const entryFromObject = (item: Record<string, unknown>): ManualBatchEntry | null => {
  const taskId = coerceTaskId(item.task_id ?? item.taskId ?? item.id)
  const response = item.response ?? item.answer ?? item.patch ?? item.diff ?? item.output
  if (response === null || response === undefined || !String(response).trim()) return null
  const score = item.score ?? item.result ?? item.passed
  return { taskId, response: String(response), score: score === null || score === undefined ? null : String(score) }
}

export const parseManualBatchResponse = (raw: string): ManualBatchEntry[] => {
  const text = String(raw || '').trim()
  if (!text) return []

  const tagged: ManualBatchEntry[] = []
  const tagRegex = /<benchforge_result\b([^>]*)>([\s\S]*?)<\/benchforge_result>/gi
  let tagMatch: RegExpExecArray | null
  while ((tagMatch = tagRegex.exec(text))) {
    const attrs = parseAttributes(tagMatch[1] || '')
    const response = String(tagMatch[2] || '').trim()
    if (!response) continue
    tagged.push({ taskId: coerceTaskId(attrs.task_id ?? attrs.taskId ?? attrs.id), response, score: attrs.score || attrs.result || attrs.passed || null })
  }
  if (tagged.length > 0) return tagged

  try {
    const parsed = JSON.parse(text)
    const array: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [parsed]
    return array.map((item) => item && typeof item === 'object' ? entryFromObject(item as Record<string, unknown>) : null).filter(Boolean) as ManualBatchEntry[]
  } catch {}

  const jsonl = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line)
        return parsed && typeof parsed === 'object' ? entryFromObject(parsed as Record<string, unknown>) : null
      } catch {
        return null
      }
    })
    .filter(Boolean) as ManualBatchEntry[]

  return jsonl
}

const buildBatchPrompt = (benchmarkName: string, tasks: ManualBatchTaskInput[], t: (key: TranslationKey, params?: Record<string, string | number | null | undefined>) => string) => {
  const taskIds = tasks.map((task) => taskKey(task.taskId)).join(', ')
  const taskBlocks = tasks.map((task, index) => {
    const expected = task.expectedAnswer || task.passCondition || (task.evaluationChecklist?.length ? task.evaluationChecklist.join('; ') : '')
    return [
      `## ${index + 1}. ${task.title}`,
      `task_id: ${taskKey(task.taskId)}`,
      `score_type: ${task.scoreType}`,
      `output_type: ${task.outputType}`,
      expected ? `expected_or_condition: ${expected}` : '',
      '',
      'PROMPT:',
      task.prompt,
    ].filter(Boolean).join('\n')
  }).join('\n\n---\n\n')

  return `${t('manual.batchPromptIntro', { benchmark: benchmarkName, count: tasks.length })}

${t('manual.batchPromptFormat', { taskIds })}

${tasks.map((task) => `<benchforge_result task_id="${taskKey(task.taskId)}">
${t('manual.batchAnswerPlaceholder')}
</benchforge_result>`).join('\n\n')}

${t('manual.batchPromptScoreHint')}

--- TASKS ---

${taskBlocks}`
}

export const ManualBatchDialog: React.FC<ManualBatchDialogProps> = ({ benchmarkName, tasks, batchNumber, totalBatches, largeRepoWarning = false, onSubmit, onCancel }) => {
  const { t } = useTranslation()
  const [response, setResponse] = useState('')
  const [copyStatus, setCopyStatus] = useState<string | null>(null)

  const prompt = useMemo(() => buildBatchPrompt(benchmarkName, tasks, t), [benchmarkName, tasks, t])
  const parsedEntries = useMemo(() => parseManualBatchResponse(response), [response])
  const expectedKeys = useMemo(() => new Set(tasks.map((task) => taskKey(task.taskId))), [tasks])
  const parsedKeys = useMemo(() => new Set(parsedEntries.map((entry) => taskKey(entry.taskId))), [parsedEntries])
  const missingTasks = tasks.filter((task) => !parsedKeys.has(taskKey(task.taskId)))
  const extraEntries = parsedEntries.filter((entry) => !expectedKeys.has(taskKey(entry.taskId)))
  const canSubmit = parsedEntries.length > 0 && missingTasks.length === 0 && extraEntries.length === 0

  const handleCopy = async () => {
    await navigator.clipboard.writeText(prompt)
    setCopyStatus(t('manual.promptCopied'))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4">
      <div className="max-h-[94vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-700/60 bg-[#161822] shadow-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-700/40 p-4 sm:p-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">{t('manual.batchTitle')}</h3>
            <p className="mt-1 text-sm text-slate-500">{t('manual.batchDescription', { current: batchNumber, total: totalBatches, count: tasks.length })}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onCancel}>{t('common.close')}</Button>
        </div>

        <div className="max-h-[calc(94vh-86px)] space-y-4 overflow-auto p-4 sm:p-5">
          {largeRepoWarning && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">{t('manual.batchRepoWarning')}</div>}

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">{t('common.prompt')}</label>
            <textarea readOnly value={prompt} rows={12} className="w-full rounded-lg border border-slate-600/50 bg-[#0f1117] px-3 py-2 font-mono text-xs text-slate-200 focus:outline-none" />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>{t('manual.copyPrompt')}</Button>
            <span className="text-xs text-slate-500">{copyStatus || t('manual.batchCopyHint')}</span>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">{t('manual.batchPasteResponse')}</label>
            <textarea value={response} onChange={(event) => setResponse(event.target.value)} rows={12} placeholder={t('manual.batchResponsePlaceholder')} className="w-full rounded-lg border border-slate-600/50 bg-[#0f1117] px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-500/50 focus:outline-none" />
          </div>

          <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3 text-xs text-slate-400">
            <p>{t('manual.batchParsedCount', { parsed: parsedEntries.length, total: tasks.length })}</p>
            {missingTasks.length > 0 && <p className="mt-1 text-amber-300">{t('manual.batchMissing')}: {missingTasks.map((task) => `${task.title} (#${taskKey(task.taskId)})`).join(', ')}</p>}
            {extraEntries.length > 0 && <p className="mt-1 text-red-300">{t('manual.batchExtra')}: {extraEntries.map((entry) => `#${taskKey(entry.taskId)}`).join(', ')}</p>}
          </div>

          <div className="flex justify-end gap-3 border-t border-slate-700/40 pt-4">
            <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
            <Button onClick={() => onSubmit(parsedEntries)} disabled={!canSubmit}>{t('manual.batchSubmit')}</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
