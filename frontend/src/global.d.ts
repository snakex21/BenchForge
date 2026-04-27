import type {
  AIModel,
  Benchmark,
  BenchmarkResult,
  BenchmarkRun,
  BenchForgeExportData,
  RunSession,
  Task,
} from '@/types'

declare module '*.svg' {
  const content: string
  export default content
}

interface BenchForgeDesktopApi {
  getMeta: () => Promise<{ name: string; version: string; platform: string }>
  saveJsonFile: (payload: { defaultFileName: string; content: string }) => Promise<{ canceled: boolean; filePath?: string }>
  saveTextFile: (payload: { defaultFileName?: string; extension?: string; extensionLabel?: string; content: string }) => Promise<{ canceled: boolean; filePath?: string }>
  openJsonFile: () => Promise<{ canceled: boolean; filePath?: string; content?: string }>
  openPath: (relativePath: string) => Promise<{ ok: boolean; error?: string | null }>
  exportArtifactZip: (payload: { relativePath: string; defaultFileName?: string }) => Promise<{ canceled: boolean; filePath?: string; files?: number }>
  listBenchmarkPacks: () => Promise<Array<{ id: string; name: string; source: string; description: string; category: string; defaultLimit: number; recommendedLimit: number; totalTasks?: number; homepage?: string }>>
  downloadBenchmarkPack: (payload: { id: string; limit?: number }) => Promise<{ ok: boolean; fromFallback: boolean; error?: string; pack: { id: string; name: string }; benchmarks: Array<Record<string, unknown> & { tasks?: Array<Record<string, unknown>> }> }>
  listTools: () => Promise<Array<{ id: string; name: string; description: string }>>
  runTool: (payload: { tool: string; workdir?: string; input?: Record<string, unknown>; [key: string]: unknown }) => Promise<Record<string, unknown> & { ok?: boolean; workdir?: string; tracePath?: string }>
  checkEnvironment: () => Promise<{ ok: boolean; checks: Array<Record<string, unknown> & { label?: string; ok?: boolean; version?: string; required?: boolean }> }>
  getMcpServers: () => Promise<Array<Record<string, unknown>>>
  saveMcpServers: (servers: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>>
  listMcpTools: () => Promise<Array<{ server: { id: string; name: string }; ok: boolean; tools: Array<Record<string, unknown>>; error?: string }>>
  callMcpTool: (payload: { serverId: string; toolName: string; arguments?: Record<string, unknown> }) => Promise<Record<string, unknown>>
  judgeEvaluate: (payload: { modelId: number; taskPrompt?: string; checklist?: string[]; response: string }) => Promise<Record<string, unknown>>
}

interface BenchForgeDbApi {
  getModels: () => Promise<AIModel[]>
  addModel: (payload: Omit<AIModel, 'id' | 'created_at'>) => Promise<AIModel>
  updateModel: (payload: { id: number; data: Partial<Omit<AIModel, 'id' | 'created_at'>> }) => Promise<AIModel | null>
  deleteModel: (payload: { id: number }) => Promise<{ changes: number }>
  getDiscoveredModels: (payload?: { provider?: string }) => Promise<Array<{ provider: string; modelId: string; baseUrl?: string | null; lastSeenAt?: string }>>
  getBenchmarks: () => Promise<Benchmark[]>
  addBenchmark: (payload: Omit<Benchmark, 'id' | 'created_at'>) => Promise<Benchmark>
  updateBenchmark: (payload: { id: number; data: Partial<Omit<Benchmark, 'id' | 'created_at'>> }) => Promise<Benchmark>
  deleteBenchmark: (payload: { id: number }) => Promise<{ changes: number }>
  tasks: {
    get: (payload: { benchmarkId: number }) => Promise<Task[]>
    add: (payload: { benchmarkId: number; name: string; promptTemplate: string; scoreType: 'numeric' | 'boolean'; expectedAnswer?: 'tak' | 'nie' | null; passCondition?: string | null; evaluationChecklist?: string[]; evaluationRubric?: unknown[]; attempts?: number; outputType?: 'text' | 'html' | 'svg' | 'markdown' | 'maze'; referenceImage?: string | null; orderIndex?: number }) => Promise<Task>
    update: (payload: { id: number; data: Record<string, unknown> }) => Promise<Task>
    delete: (payload: { id: number }) => Promise<{ changes: number }>
    reorder: (payload: { benchmarkId: number; orderedIds: number[] }) => Promise<Task[]>
  }
  getResults: () => Promise<BenchmarkResult[]>
  addResult: (payload: Omit<BenchmarkResult, 'id'>) => Promise<BenchmarkResult>
  deleteResult: (payload: { id: number }) => Promise<{ changes: number }>
  clearResults?: () => Promise<{ results: BenchmarkResult[]; runs: BenchmarkRun[] }>
  rebuildResultArtifacts?: () => Promise<{ created: number }>
  getRuns: () => Promise<BenchmarkRun[]>
  addRun: (payload: Omit<BenchmarkRun, 'id'>) => Promise<BenchmarkRun>
  updateRun: (payload: { id: number; data: Partial<Omit<BenchmarkRun, 'id'>> }) => Promise<BenchmarkRun>
  runSession: {
    create: (payload: { model_id: number; benchmark_ids: number[]; current_benchmark_id?: number | null; current_task_id?: number | null; completed_task_ids?: number[] }) => Promise<RunSession>
    getActive: () => Promise<RunSession | null>
    update: (payload: { id: number; data: Partial<RunSession> }) => Promise<RunSession>
    finish: (payload: { id: number }) => Promise<RunSession>
    cancel: (payload: { id: number }) => Promise<RunSession>
  }
  exportAll: () => Promise<BenchForgeExportData>
  clearAllData: () => Promise<BenchForgeExportData>
  importAll: (payload: BenchForgeExportData) => Promise<BenchForgeExportData>
  testConnection: (payload: { modelId?: number; modelConfig?: Omit<AIModel, 'id' | 'created_at'> }) => Promise<{ ok: boolean; error: string | null }>
  scanModels: (payload?: { endpoints?: Array<{ key?: string; name: string; url: string; type?: string; apiKey?: string; scanPath?: string; authType?: string; scanUnsupported?: boolean; requiresApiKey?: boolean }> }) => Promise<{ lmstudio: string[]; ollama: string[]; errors: Record<string, string> } & Record<string, string[] | Record<string, string>>>
  sendPrompt: (payload: { modelId: number; prompt: string }) => Promise<{ response: string; tokens_used: number | null; is_manual: boolean }>
  runBenchmark: (payload: { modelId: number; benchmarkId: number }) => Promise<{
    results?: Array<{ benchmark_id: number; score: string | null; response: string | null; tokens_used: number | null; is_manual: boolean; error: string | null }>
    summary?: { total: number; completed: number; avgScore: number | null }
    score?: string | number | null
    response?: string | null
    tokens_used?: number | null
    is_manual?: boolean
    error: string | null
  }>
  submitManualResult: (payload: { modelId: number; benchmarkId: number; taskId?: number | null; response: string; score: string; thinkingNotes?: string | null }) => Promise<{ ok: boolean; resultId: number | null; error?: string | null }>
  runBenchmarkStreaming: (payload: { modelId: number; benchmarkId: number; sessionId?: number; taskIds?: number[] }) => Promise<{ started: boolean; error?: string | null }>
  abortBenchmark: () => Promise<{ ok: boolean }>
  submitManualStreaming: (payload: { modelId: number; benchmarkId: number; taskId?: number | null; runSessionId?: number | null; response: string; score: string; attemptNumber?: number; tokensUsed?: number | null; durationMs?: number | null; thinkingNotes?: string | null }) => Promise<{ ok: boolean; resultId: number | null; error?: string | null }>
  onStreamEvent: (callback: (eventName: 'task:chunk' | 'task:thinking-chunk' | 'task:done' | 'task:error' | 'task:retry' | 'task:tool-call' | 'task:needs-maze-verify' | 'benchmark:done' | 'benchmark:aborted', data: Record<string, unknown>) => void) => void
  onAborted: (callback: () => void) => void
  removeStreamListeners: () => void
  savePreference: (key: string, value: unknown) => Promise<void>
  getPreference: (key: string) => Promise<unknown>
}

declare global {
  interface Window {
    benchforge?: BenchForgeDesktopApi
    db?: BenchForgeDbApi
  }
}

export {}
