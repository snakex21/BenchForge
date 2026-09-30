import { useEffect, useState } from 'react'
import { StatsView } from '@/features/arena/StatsView'
import { useModelStore } from '@/store/modelStore'
import { useBenchmarkStore } from '@/store/benchmarkStore'
import { useResultStore } from '@/store/resultStore'
import { useUIStore } from '@/store/uiStore'
import { LANGUAGE_OPTIONS, type Language, useTranslation } from '@/i18n'
import { createReadOnlyTransport, type ReadOnlyTransport, type SnapshotMeta } from './transport'

export async function loadReadOnlyStores(api: ReadOnlyTransport): Promise<SnapshotMeta> {
  const meta = await api.getMeta()
  const [models, results, runs] = await Promise.all([api.getModels(), api.getResults(), api.getRuns()])
  await useBenchmarkStore.getState().loadFromDb({ readOnly: true, source: api })
  useModelStore.setState({ models, isLoading: false })
  useResultStore.setState({ results, runs, isLoading: false })
  return meta
}

export function SnapshotViewer({ api }: { api?: ReadOnlyTransport }) {
  const [meta, setMeta] = useState<SnapshotMeta | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'stats' | 'inventory'>('stats')
  const { language, t } = useTranslation()
  const setLanguage = useUIStore(s => s.setLanguage)
  const models = useModelStore(s => s.models)
  const benchmarks = useBenchmarkStore(s => s.benchmarks)
  const tasks = useBenchmarkStore(s => s.tasks)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    loadReadOnlyStores(api || createReadOnlyTransport(controller.signal)).then(value => { if (active) setMeta(value) }).catch(reason => { if (active) setError(reason.message || String(reason)) })
    return () => { active = false; controller.abort() }
  }, [api])
  useEffect(() => {
    document.documentElement.lang = language
    document.documentElement.dir = ['ar', 'he', 'fa', 'ur'].includes(language) ? 'rtl' : 'ltr'
    document.documentElement.dataset.theme = 'dark'
  }, [language])
  return <div className="min-h-screen bg-slate-950 text-slate-200">
    <header className="border-b border-slate-700 bg-slate-900 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-xl font-semibold">BenchForge · Read-only snapshot</h1><label className="text-sm">Language / Język <select aria-label="Language / Język" value={language} onChange={e => setLanguage(e.target.value as Language)} className="ml-2 rounded border border-slate-600 bg-slate-950 p-2">{LANGUAGE_OPTIONS.map(item => <option key={item.id} value={item.id}>{item.nativeLabel}</option>)}</select></label></div>
      <p className="mt-2 text-sm text-amber-200">Historical display only. No edits, cleanup, model calls, imports, tools, MCP or update actions are enabled.</p>
      {meta && <p className="mt-2 text-xs text-slate-400">{meta.label} · {meta.source_kind} · {meta.evaluator_origin} · SHA-256 {meta.snapshot_sha256}</p>}
      <p className="mt-1 text-xs text-slate-400">Legacy scores are not comparable to benchforge-text-v1. This is one verified read-only slice, not full migration parity.</p>
    </header>
    <main className="mx-auto max-w-[1600px] p-4 sm:p-6">
      {error ? <p role="alert" className="rounded border border-red-600 p-4 text-red-200">Unable to load snapshot: {error}</p> : !meta ? <p role="status">Loading snapshot…</p> : <>
        <nav aria-label="Read-only views" className="mb-4 flex gap-3"><button className="rounded border border-slate-600 px-4 py-2" aria-pressed={tab==='stats'} onClick={()=>setTab('stats')}>{t('nav.stats')}</button><button className="rounded border border-slate-600 px-4 py-2" aria-pressed={tab==='inventory'} onClick={()=>setTab('inventory')}>Snapshot inventory</button></nav>
        {tab==='stats' ? <StatsView/> : <section><h2 className="mb-4 text-lg font-medium">Preserved models, benchmarks and tasks</h2><p className="mb-4">{models.length} models · {benchmarks.length} benchmarks · {tasks.length} tasks</p><ul className="space-y-2">{models.map(m=><li className="rounded border border-slate-700 p-3" key={m.id}>{m.name} · {m.model_id || m.mode}</li>)}</ul><ul className="mt-4 space-y-2">{benchmarks.map(b=><li className="rounded border border-slate-700 p-3" key={b.id}>{b.name}<ul>{tasks.filter(t=>t.benchmark_id===b.id).map(task=><li key={task.id} className="ml-4 mt-1 text-sm text-slate-400">{task.name}</li>)}</ul></li>)}</ul></section>}
      </>}
    </main>
  </div>
}
