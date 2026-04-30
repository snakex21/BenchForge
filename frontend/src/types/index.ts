export type ScoreType = 'numeric' | 'boolean'
export type ScoreValue = string
export type OutputType = 'text' | 'html' | 'svg' | 'markdown' | 'maze'

export interface EvaluationRubricItem {
  id?: string
  label: string
  points: number
  type?: 'checkbox' | 'scale' | 'auto_sandbox'
  min?: number
  max?: number
  description?: string
}

export type ModelMode = 'api' | 'manual'
export type ApiProvider = 'lmstudio' | 'ollama' | 'openai' | 'anthropic' | 'google-gemini' | 'nvidia-nim' | 'deepseek' | 'qwen' | 'minimax' | 'moonshot' | 'zhipuai' | 'baidu' | 'yi' | 'openrouter' | 'groq' | 'together' | 'fireworks' | 'mistral' | 'cohere' | 'perplexity' | 'ai21' | 'liquid-ai' | 'openai-compatible'

export interface Benchmark {
  id: number
  name: string
  category: string
  description?: string | null
  suite_name?: string | null
  prompt_template: string
  score_type: ScoreType
  expected_answer?: 'tak' | 'nie' | null
  pass_condition?: string | null
  evaluation_checklist?: string[]
  evaluation_rubric?: EvaluationRubricItem[]
  attempts: number
  output_type: OutputType
  reference_image?: string | null
  created_at: string
  tasks?: Task[]
}

export interface Task {
  id: number
  benchmark_id: number
  name: string
  prompt_template: string
  score_type: ScoreType
  expected_answer?: 'tak' | 'nie' | null
  pass_condition?: string | null
  evaluation_checklist?: string[]
  evaluation_rubric?: EvaluationRubricItem[]
  attempts: number
  order_index: number
  output_type: OutputType
  reference_image?: string | null
  created_at: string
}

export interface AIModel {
  id: number
  name: string
  mode: ModelMode
  provider?: ApiProvider
  base_url?: string | null
  api_key?: string | null
  model_id?: string | null
  created_at: string
}

export interface BenchmarkResult {
  id: number
  model_id: number
  benchmark_id: number
  task_id?: number | null
  run_session_id?: number | null
  score: string
  notes?: string | null
  thinking_notes?: string | null
  response_preview?: string | null
  artifact_path?: string | null
  attempt_number: number
  tokens_used?: number | null
  duration_ms?: number | null
  run_at: string
}

export interface BenchmarkRun {
  id: number
  name?: string | null
  started_at: string
  finished_at?: string | null
  status: string
}

export interface RunSession {
  id: number
  model_id: number
  benchmark_ids: number[]
  status: 'running' | 'finished' | 'cancelled' | 'interrupted'
  current_benchmark_id?: number | null
  current_task_id?: number | null
  completed_task_ids: number[]
  started_at: string
  updated_at: string
}

export interface BenchForgeExportData {
  models: AIModel[]
  benchmarks: Benchmark[]
  tasks?: Task[]
  results: BenchmarkResult[]
  runs: BenchmarkRun[]
}

export interface UIState {
  sidebarCollapsed: boolean
  activeView: ActiveView
  selectedModelId: number | null
  selectedBenchmarkId: number | null
  rightPanelOpen: boolean
  thinkingPanelOpen: boolean
  theme: 'dark' | 'light' | 'cyberpunk' | 'graphite'
  language: 'pl' | 'en' | 'de' | 'es' | 'fr' | 'it' | 'pt' | 'uk' | 'cs' | 'nl' | 'tr' | 'ja' | 'ru' | 'zh' | 'zh-TW' | 'ko' | 'id' | 'vi' | 'th' | 'hi' | 'ar' | 'he' | 'el' | 'sv' | 'no' | 'da' | 'fi' | 'hu' | 'ro' | 'bg' | 'hr' | 'sk' | 'sl' | 'lt' | 'lv' | 'et' | 'sr' | 'ca' | 'eu' | 'gl' | 'ga' | 'cy' | 'is' | 'mt' | 'sq' | 'mk' | 'be' | 'bs' | 'lb' | 'gd' | 'br' | 'co' | 'fy' | 'fa' | 'ur' | 'ms' | 'fil' | 'bn'
  rerunTarget: { modelId: number; benchmarkId: number; taskIds?: number[] } | null
  keyboardShortcuts: KeyboardShortcuts
}

export type ActiveView = 'arena' | 'runner' | 'models' | 'benchmarks' | 'results' | 'stats' | 'settings'

export interface KeyboardShortcut {
  key: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

export interface KeyboardShortcuts {
  goToArena: KeyboardShortcut
  goToRunner: KeyboardShortcut
  goToModels: KeyboardShortcut
  goToBenchmarks: KeyboardShortcut
  goToResults: KeyboardShortcut
  goToStats: KeyboardShortcut
  goToSettings: KeyboardShortcut
  toggleSidebar: KeyboardShortcut
  toggleRightPanel: KeyboardShortcut
  closePanel: KeyboardShortcut
}

export type KeyboardAction = keyof KeyboardShortcuts
