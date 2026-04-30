// ============================================================
// SettingsView — ustawienia aplikacji
// ============================================================

import React, { useEffect, useState } from 'react'
import { useUIStore } from '@/store/uiStore'
import { useModelStore } from '@/store/modelStore'
import { useBenchmarkStore } from '@/store/benchmarkStore'
import { useResultStore } from '@/store/resultStore'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { LANGUAGE_OPTIONS, useTranslation } from '@/i18n'
import { formatShortcut } from '@/hooks/useKeyboardShortcuts'
import type { KeyboardAction, KeyboardShortcut } from '@/types'

export const SettingsView: React.FC = () => {
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed)
  const theme = useUIStore((state) => state.theme)
  const language = useUIStore((state) => state.language)
  const keyboardShortcuts = useUIStore((state) => state.keyboardShortcuts)
  const toggleSidebar = useUIStore((state) => state.toggleSidebar)
  const setTheme = useUIStore((state) => state.setTheme)
  const setLanguage = useUIStore((state) => state.setLanguage)
  const setKeyboardShortcuts = useUIStore((state) => state.setKeyboardShortcuts)
  const resetKeyboardShortcuts = useUIStore((state) => state.resetKeyboardShortcuts)
  const loadModels = useModelStore((state) => state.loadFromDb)
  const loadBenchmarks = useBenchmarkStore((state) => state.loadFromDb)
  const loadResults = useResultStore((state) => state.loadFromDb)
  const models = useModelStore((state) => state.models)
  const { t } = useTranslation()
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [tools, setTools] = useState<Array<{ id: string; name: string; description: string }>>([])
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [toolWorkdir, setToolWorkdir] = useState<string | null>(null)
  const [mcpServersText, setMcpServersText] = useState('[]')
  const [mcpToolsText, setMcpToolsText] = useState<string | null>(null)
  const [repoSandboxText, setRepoSandboxText] = useState('[]')
  const [helpTopic, setHelpTopic] = useState<'mcp' | 'repo' | null>(null)
  const [environmentChecks, setEnvironmentChecks] = useState<Array<Record<string, unknown> & { label?: string; group?: string; ok?: boolean; version?: string; required?: boolean; error?: string | null }> | null>(null)
  const [sandboxUseDocker, setSandboxUseDocker] = useState(false)
  const [judgeModelId, setJudgeModelId] = useState<number | ''>('')
  const [dataPath, setDataPath] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<Awaited<ReturnType<NonNullable<typeof window.benchforge>['checkForUpdates']>> | null>(null)
  const [updateStatus, setUpdateStatus] = useState<string | null>(null)
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false)
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false)
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false)
  const [editingShortcut, setEditingShortcut] = useState<KeyboardAction | null>(null)

  const themes = [
    { id: 'dark', name: t('settings.themeDark'), colors: ['#0f1117', '#6366f1', '#e2e8f0'] },
    { id: 'light', name: t('settings.themeLight'), colors: ['#eef2ff', '#4f46e5', '#0f172a'] },
    { id: 'cyberpunk', name: t('settings.themeCyberpunk'), colors: ['#080514', '#ec4899', '#22d3ee'] },
    { id: 'graphite', name: t('settings.themeGraphite'), colors: ['#111111', '#737373', '#e5e5e5'] },
  ] as const

  useEffect(() => {
    void window.benchforge?.listTools?.().then((items) => setTools(items || []))
    void window.benchforge?.getMcpServers?.().then((servers) => setMcpServersText(JSON.stringify(servers || [], null, 2)))
    void window.db?.getPreference?.('repo_sandbox_roots').then((value) => setRepoSandboxText(JSON.stringify(Array.isArray(value) ? value : [], null, 2)))
    void window.db?.getPreference?.('sandbox_use_docker').then((value) => setSandboxUseDocker(Boolean(value)))
    void window.db?.getPreference?.('judge_model_id').then((value) => setJudgeModelId(typeof value === 'number' ? value : ''))
    void window.benchforge?.getDataPath?.().then((value) => setDataPath(value || null))
  }, [])

  const refreshData = async () => {
    await Promise.all([loadModels(), loadBenchmarks(), loadResults()])
  }

  const handleExportAll = async () => {
    if (!window.db || !window.benchforge?.saveJsonFile) return

    const payload = await window.db.exportAll()
    const result = await window.benchforge.saveJsonFile({
      defaultFileName: `benchforge-backup-${Date.now()}.json`,
      content: JSON.stringify(payload, null, 2),
    })

    if (!result.canceled) {
      setStatusMessage(`${t('settings.exportSaved')} ${result.filePath}`)
    }
  }

  const handleImportAll = async () => {
    if (!window.db || !window.benchforge?.openJsonFile) return

    const file = await window.benchforge.openJsonFile()
    if (file.canceled || !file.content) return

    const confirmed = confirm(t('settings.importConfirm'))
    if (!confirmed) return

    try {
      const parsed = JSON.parse(file.content)
      await window.db.importAll(parsed)
      await refreshData()
      setStatusMessage(`${t('settings.imported')} ${file.filePath}`)
    } catch {
      setStatusMessage(t('settings.importFailed'))
    }
  }

  const handleRebuildArtifacts = async () => {
    const result = await window.db?.rebuildResultArtifacts?.()
    setStatusMessage(t('settings.artifactsRebuilt', { count: result?.created ?? 0 }))
    await refreshData()
  }

  const handleClearAllData = async () => {
    if (!window.db) return
    const confirmed = confirm(t('settings.clearAllConfirm'))
    if (!confirmed) return

    await window.db.clearAllData()
    await refreshData()
    setStatusMessage(t('settings.allDataCleared'))
  }

  const handleShortcutKeyDown = (action: KeyboardAction, event: React.KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()

    // Ignore if only modifier keys are pressed
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return

    const newShortcut: KeyboardShortcut = {
      key: event.key,
      ctrl: event.ctrlKey || event.metaKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    }

    setKeyboardShortcuts({ [action]: newShortcut })
    setEditingShortcut(null)
  }

  const SHORTCUT_LABELS: Record<KeyboardAction, string> = {
    goToArena: t('nav.arena'),
    goToRunner: t('nav.runner'),
    goToModels: t('nav.models'),
    goToBenchmarks: t('nav.benchmarks'),
    goToResults: t('nav.results'),
    goToStats: t('nav.stats'),
    goToSettings: t('nav.settings'),
    toggleSidebar: t('settings.collapseSidebar'),
    toggleRightPanel: t('settings.toggleRightPanel'),
    closePanel: t('settings.closePanel'),
  }

  const runToolSmoke = async (tool: 'python.run' | 'node.run') => {
    const payload = tool === 'python.run'
      ? { tool, input: { code: 'print("BenchForge Python tool OK")', timeoutMs: 5000 } }
      : { tool, input: { code: 'console.log("BenchForge Node tool OK")', timeoutMs: 5000 } }
    const result = await window.benchforge?.runTool?.(payload)
    setToolWorkdir(typeof result?.workdir === 'string' ? result.workdir : null)
    if (result?.ok) setToolStatus(t('settings.toolTestOk', { workdir: String(result.workdir || '') }))
    else setToolStatus(t('settings.toolTestFailed', { error: String(result?.stderr || result?.error || 'unknown') }))
  }

  const saveMcpServers = async () => {
    try {
      const parsed = JSON.parse(mcpServersText || '[]')
      if (!Array.isArray(parsed)) throw new Error(t('settings.mcpConfigArrayError'))
      await window.benchforge?.saveMcpServers?.(parsed)
      setToolStatus(t('settings.mcpSaved'))
    } catch {
      setToolStatus(t('settings.mcpInvalidJson'))
    }
  }

  const listMcpTools = async () => {
    await saveMcpServers()
    const result = await window.benchforge?.listMcpTools?.()
    const count = (result || []).reduce((sum, server) => sum + (Array.isArray(server.tools) ? server.tools.length : 0), 0)
    setToolStatus(t('settings.mcpToolsFound', { count }))
    setMcpToolsText(JSON.stringify(result || [], null, 2))
  }

  const insertMcpExample = () => {
    setMcpServersText(JSON.stringify([
      {
        id: 'fs',
        name: 'Filesystem MCP',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/tmp'],
        disabled: false,
        timeoutMs: 20000,
      },
    ], null, 2))
  }

  const insertRepoSandboxExample = () => {
    setRepoSandboxText(JSON.stringify([
      {
        repo: 'django/django',
        path: 'C:/src/django',
        testCommand: 'python -m pytest tests/...',
        timeoutMs: 120000,
      },
      {
        instanceId: 'example__repo-12345',
        repo: 'owner/repo',
        path: 'C:/src/repo',
        testCommand: 'npm test',
        timeoutMs: 120000,
      },
    ], null, 2))
  }

  const saveRepoSandbox = async () => {
    try {
      const parsed = JSON.parse(repoSandboxText || '[]')
      if (!Array.isArray(parsed)) throw new Error(t('settings.repoSandboxArrayError'))
      await window.db?.savePreference?.('repo_sandbox_roots', parsed)
      setToolStatus(t('settings.repoSandboxSaved'))
    } catch {
      setToolStatus(t('settings.repoSandboxInvalidJson'))
    }
  }

  const runEnvironmentCheck = async () => {
    const result = await window.benchforge?.healthCheck?.() || await window.benchforge?.checkEnvironment?.()
    setEnvironmentChecks(result?.checks || [])
    setToolStatus(result?.ok ? t('settings.environmentOk') : t('settings.environmentFailed'))
  }

  const toggleDockerSandbox = async () => {
    const next = !sandboxUseDocker
    setSandboxUseDocker(next)
    await window.db?.savePreference?.('sandbox_use_docker', next)
  }

  const saveJudgeModel = async (value: number | '') => {
    setJudgeModelId(value)
    await window.db?.savePreference?.('judge_model_id', value === '' ? null : value)
  }

  const checkUpdates = async () => {
    setIsCheckingUpdates(true)
    setUpdateStatus(t('settings.updatesChecking'))
    try {
      const result = await window.benchforge?.checkForUpdates?.()
      setUpdateInfo(result || null)
      setUpdateStatus(result?.noRelease ? t('settings.updatesNoRelease') : result?.updateAvailable ? t('settings.updatesAvailable', { version: result.latestVersion }) : t('settings.updatesNone'))
    } catch (error) {
      setUpdateStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsCheckingUpdates(false)
    }
  }

  const downloadUpdate = async (kind: 'zip' | 'portable' | 'setup' = 'zip') => {
    setIsDownloadingUpdate(true)
    setUpdateStatus(t('settings.updatesDownloading'))
    try {
      const result = await window.benchforge?.downloadUpdate?.({ kind })
      if (!result || result.canceled) {
        setUpdateStatus(t('common.cancel'))
        return
      }
      setUpdateStatus(t('settings.updatesDownloaded', { file: result.filePath || result.assetName || '' }) + (result.checksumVerified ? ` ${t('settings.updatesChecksumOk')}` : ''))
    } catch (error) {
      setUpdateStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setIsDownloadingUpdate(false)
    }
  }

  const installPortableUpdate = async () => {
    const confirmed = confirm(t('settings.updatesInstallConfirm'))
    if (!confirmed) return
    setIsApplyingUpdate(true)
    setUpdateStatus(t('settings.updatesInstalling'))
    try {
      await window.benchforge?.applyPortableUpdate?.()
      setUpdateStatus(t('settings.updatesInstallStarted'))
    } catch (error) {
      setUpdateStatus(error instanceof Error ? error.message : String(error))
      setIsApplyingUpdate(false)
    }
  }

  return (
    <div className="w-full space-y-6">
      <h2 className="text-xl font-bold text-slate-100">{t('settings.title')}</h2>

      <Card title={t('settings.appearance')}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div>
              <p className="text-sm text-slate-300">{t('settings.collapseSidebar')}</p>
              <p className="mt-0.5 text-xs text-slate-500">{t('settings.collapseSidebarDescription')}</p>
            </div>
            <button
              onClick={toggleSidebar}
              className={`relative h-6 w-12 rounded-full transition-colors duration-200 ${sidebarCollapsed ? 'bg-indigo-600' : 'bg-slate-600'}`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${sidebarCollapsed ? 'left-[26px]' : 'left-0.5'}`}
              />
            </button>
          </div>

          <div className="py-2">
            <p className="text-sm text-slate-300">{t('settings.theme')}</p>
            <p className="mt-0.5 text-xs text-slate-500">{t('settings.themeDescription')}</p>
            <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(16rem,100%),1fr))] gap-3">
              {themes.map((item) => (
                <button key={item.id} type="button" onClick={() => setTheme(item.id)} className={`rounded-xl border p-3 text-left transition ${theme === item.id ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-700/40 bg-slate-950/30 hover:border-slate-500'}`}>
                  <div className="flex items-center justify-between"><span className="text-sm font-medium text-slate-200">{item.name}</span>{theme === item.id && <span>✓</span>}</div>
                  <div className="mt-3 flex gap-2">{item.colors.map((color) => <span key={color} className="h-7 flex-1 rounded" style={{ backgroundColor: color }} />)}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="py-2">
            <p className="text-sm text-slate-300">{t('settings.language')}</p>
            <p className="mt-0.5 text-xs text-slate-500">{t('settings.languageDescription')}</p>
            <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-3">
              {LANGUAGE_OPTIONS.map((item) => (
                <button key={item.id} type="button" onClick={() => setLanguage(item.id)} className={`rounded-xl border p-3 text-left transition ${language === item.id ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-700/40 bg-slate-950/30 hover:border-slate-500'}`}>
                  <div className="flex items-center justify-between gap-3"><span className="text-sm font-medium text-slate-200">{item.flag} {t(`settings.language.${item.id}`)}</span>{language === item.id && <span>✓</span>}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card title={t('settings.keyboardShortcuts')}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">{t('settings.keyboardShortcutsDescription')}</p>
            <Button variant="ghost" size="sm" onClick={resetKeyboardShortcuts}>
              {t('settings.resetShortcuts')}
            </Button>
          </div>
          <div className="space-y-2">
            {(Object.entries(keyboardShortcuts) as [KeyboardAction, KeyboardShortcut][]).map(([action, shortcut]) => (
              <div key={action} className="flex items-center justify-between rounded-lg border border-slate-700/40 bg-slate-950/30 px-4 py-2.5">
                <span className="text-sm text-slate-300">{SHORTCUT_LABELS[action]}</span>
                {editingShortcut === action ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">{t('settings.pressKeys')}</span>
                    <kbd
                      className="rounded border border-indigo-500/50 bg-indigo-500/10 px-2 py-1 text-xs font-mono text-indigo-300"
                      onKeyDown={(e) => handleShortcutKeyDown(action, e)}
                      tabIndex={0}
                      autoFocus
                    >
                      ...
                    </kbd>
                    <Button variant="ghost" size="sm" onClick={() => setEditingShortcut(null)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                ) : (
                  <button
                    onClick={() => setEditingShortcut(action)}
                    className="rounded border border-slate-600/50 bg-slate-800/50 px-3 py-1 text-xs font-mono text-slate-300 transition hover:border-indigo-400/60 hover:bg-indigo-500/10 hover:text-indigo-300"
                  >
                    {formatShortcut(shortcut)}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card title={t('settings.toolRuntime')}>
        <div className="space-y-4">
          <p className="text-sm text-slate-500">{t('settings.toolRuntimeDescription')}</p>
          <div>
            <p className="mb-2 text-sm text-slate-300">{t('settings.availableTools')}</p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))] gap-2">
              {tools.map((tool) => (
                <div key={tool.id} className="rounded-lg border border-slate-700/40 bg-slate-950/30 p-3">
                  <p className="text-xs font-semibold text-slate-200">{tool.id}</p>
                  <p className="mt-1 text-xs text-slate-500">{tool.description}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void runToolSmoke('python.run')}>{t('settings.testPythonTool')}</Button>
            <Button variant="secondary" size="sm" onClick={() => void runToolSmoke('node.run')}>{t('settings.testNodeTool')}</Button>
            <Button variant="secondary" size="sm" onClick={() => void runEnvironmentCheck()}>{t('settings.environmentCheck')}</Button>
            {toolWorkdir && <Button variant="ghost" size="sm" onClick={() => void window.benchforge?.openPath?.(toolWorkdir)}>{t('settings.openToolArtifacts')}</Button>}
          </div>
          {environmentChecks && <div className="grid grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))] gap-2">
            {environmentChecks.map((check, index) => <div key={index} className={`rounded-lg border p-3 text-xs ${check.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : check.required ? 'border-red-500/30 bg-red-500/10 text-red-100' : 'border-amber-500/30 bg-amber-500/10 text-amber-100'}`}><p className="font-semibold">{check.ok ? '✅' : check.required ? '❌' : '⚠️'} {String(check.label || '')}</p><p className="mt-1 opacity-80">{String(check.version || check.error || check.command || '')}</p></div>)}
          </div>}
          <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-200">{t('settings.useDockerSandbox')}</p>
                <p className="mt-1 text-xs text-slate-500">{t('settings.useDockerSandboxDescription')}</p>
              </div>
              <button onClick={() => void toggleDockerSandbox()} className={`relative h-6 w-12 rounded-full transition-colors duration-200 ${sandboxUseDocker ? 'bg-indigo-600' : 'bg-slate-600'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${sandboxUseDocker ? 'left-[26px]' : 'left-0.5'}`} /></button>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3">
            <p className="text-sm font-semibold text-slate-200">{t('settings.judgeModel')}</p>
            <p className="mt-1 text-xs text-slate-500">{t('settings.judgeModelDescription')}</p>
            <select className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" value={judgeModelId} onChange={(event) => void saveJudgeModel(event.target.value ? Number(event.target.value) : '')}>
              <option value="">—</option>
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </div>
          <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3">
            <p className="text-sm font-semibold text-slate-200">{t('settings.mcpServers')}</p>
            <p className="mt-1 text-xs text-slate-500">{t('settings.mcpServersDescription')}</p>
            <textarea className="mt-3 h-40 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200" value={mcpServersText} onChange={(event) => setMcpServersText(event.target.value)} />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void saveMcpServers()}>{t('settings.saveMcpServers')}</Button>
              <Button variant="secondary" size="sm" onClick={() => void listMcpTools()}>{t('settings.listMcpTools')}</Button>
              <Button variant="ghost" size="sm" onClick={insertMcpExample}>{t('settings.insertExample')}</Button>
              <Button variant="ghost" size="sm" onClick={() => setHelpTopic('mcp')}>{t('settings.howToUse')}</Button>
            </div>
            {mcpToolsText && <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-slate-950/70 p-3 text-xs text-slate-400">{mcpToolsText}</pre>}
          </div>
          <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3">
            <p className="text-sm font-semibold text-slate-200">{t('settings.repoSandbox')}</p>
            <p className="mt-1 text-xs text-slate-500">{t('settings.repoSandboxDescription')}</p>
            <textarea className="mt-3 h-40 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200" value={repoSandboxText} onChange={(event) => setRepoSandboxText(event.target.value)} />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void saveRepoSandbox()}>{t('settings.saveRepoSandbox')}</Button>
              <Button variant="ghost" size="sm" onClick={insertRepoSandboxExample}>{t('settings.insertExample')}</Button>
              <Button variant="ghost" size="sm" onClick={() => setHelpTopic('repo')}>{t('settings.howToUse')}</Button>
            </div>
          </div>
          {toolStatus && <p className="text-xs text-slate-500">{toolStatus}</p>}
        </div>
      </Card>

      <Card title={t('settings.dataLocation')}>
        <div className="space-y-3">
          <p className="text-sm text-slate-500">{t('settings.dataLocationDescription')}</p>
          <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('settings.currentDataFolder')}</p>
            <p className="mt-2 break-all font-mono text-sm text-slate-200">{dataPath || '—'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void window.benchforge?.openDataPath?.()}>{t('settings.openDataFolder')}</Button>
          </div>
        </div>
      </Card>

      <Card title={t('settings.updates')}>
        <div className="space-y-4">
          <p className="text-sm text-slate-500">{t('settings.updatesDescription')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void checkUpdates()} disabled={isCheckingUpdates}>{isCheckingUpdates ? t('settings.updatesChecking') : t('settings.updatesCheck')}</Button>
            {updateInfo?.htmlUrl && <Button variant="ghost" size="sm" onClick={() => void window.benchforge?.openExternal?.(updateInfo.htmlUrl)}>{t('settings.updatesOpenRelease')}</Button>}
            {updateInfo?.recommended?.zip && updateInfo.updateAvailable && <Button variant="secondary" size="sm" onClick={() => void installPortableUpdate()} disabled={isApplyingUpdate || isDownloadingUpdate}>{isApplyingUpdate ? t('settings.updatesInstalling') : t('settings.updatesInstallPortable')}</Button>}
            {updateInfo?.recommended?.zip && <Button variant="secondary" size="sm" onClick={() => void downloadUpdate('zip')} disabled={isDownloadingUpdate}>{t('settings.updatesDownloadZip')}</Button>}
            {updateInfo?.recommended?.portable && <Button variant="ghost" size="sm" onClick={() => void downloadUpdate('portable')} disabled={isDownloadingUpdate}>{t('settings.updatesDownloadPortable')}</Button>}
          </div>
          {updateInfo && <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="text-slate-400">{t('settings.updatesCurrent')}:</span><strong className="text-slate-200">{updateInfo.currentVersion}</strong><span className="text-slate-400">{t('settings.updatesLatest')}:</span><strong className={updateInfo.updateAvailable ? 'text-emerald-300' : 'text-slate-200'}>{updateInfo.latestVersion}</strong></div>
            {updateInfo.body && <details className="mt-3"><summary className="cursor-pointer text-xs text-slate-400">{t('settings.updatesChangelog')}</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-3 text-xs text-slate-300">{updateInfo.body}</pre></details>}
          </div>}
          {updateStatus && <p className="text-xs text-slate-500">{updateStatus}</p>}
        </div>
      </Card>

      <Card title={t('settings.backupData')}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div>
              <p className="text-sm text-slate-300">{t('settings.backupDatabase')}</p>
              <p className="mt-0.5 text-xs text-slate-500">{t('settings.backupDatabaseDescription')}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void handleExportAll()}>
              {t('settings.makeBackup')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div>
              <p className="text-sm text-slate-300">{t('settings.restoreBackup')}</p>
              <p className="mt-0.5 text-xs text-slate-500">{t('settings.restoreBackupDescription')}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void handleImportAll()}>
              {t('settings.restore')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div>
              <p className="text-sm text-slate-300">{t('settings.rebuildArtifacts')}</p>
              <p className="mt-0.5 text-xs text-slate-500">{t('settings.rebuildArtifactsDescription')}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void handleRebuildArtifacts()}>
              {t('settings.rebuildArtifacts')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/30 py-3">
            <div>
              <p className="text-sm text-red-300">{t('settings.clearAllData')}</p>
              <p className="mt-0.5 text-xs text-slate-500">{t('settings.clearAllDataDescription')}</p>
            </div>
            <Button variant="danger" size="sm" onClick={() => void handleClearAllData()}>{t('settings.clearAllData')}</Button>
          </div>
          {statusMessage && <p className="text-xs text-slate-500">{statusMessage}</p>}
        </div>
      </Card>

      <Card title={t('settings.about')}>
        <div className="space-y-2 text-sm text-slate-400">
          <p><strong className="text-slate-200">BenchForge</strong></p>
          <p>{t('settings.aboutDescription')}</p>
          <p>{t('settings.stack')}</p>
          <p className="mt-2 text-xs text-slate-600">BenchForge v1.0.0</p>
        </div>
      </Card>

      {helpTopic && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setHelpTopic(null)}>
        <div className="w-full max-w-3xl rounded-2xl border border-slate-700/60 bg-[#161822] shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-start justify-between gap-3 border-b border-slate-700/40 p-5">
            <div>
              <h3 className="text-lg font-semibold text-slate-100">{helpTopic === 'mcp' ? t('settings.mcpHelpTitle') : t('settings.repoSandboxHelpTitle')}</h3>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setHelpTopic(null)}>{t('common.close')}</Button>
          </div>
          <div className="space-y-4 p-5">
            <pre className="whitespace-pre-wrap rounded-xl border border-slate-700/40 bg-slate-950/50 p-4 text-sm leading-relaxed text-slate-300">{helpTopic === 'mcp' ? t('settings.mcpHelpBody') : t('settings.repoSandboxHelpBody')}</pre>
            <div className="rounded-xl border border-slate-700/40 bg-slate-950/30 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">JSON</p>
              <pre className="max-h-72 overflow-auto text-xs text-slate-300">{helpTopic === 'mcp' ? JSON.stringify([{ id: 'fs', name: 'Filesystem MCP', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/tmp'], disabled: false, timeoutMs: 20000 }], null, 2) : JSON.stringify([{ repo: 'django/django', path: 'C:/src/django', testCommand: 'python -m pytest tests/...', timeoutMs: 120000 }], null, 2)}</pre>
            </div>
          </div>
        </div>
      </div>}
    </div>
  )
}
