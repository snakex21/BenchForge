const { contextBridge } = require('electron')

const now = new Date().toISOString()
const view = new URLSearchParams(window.location.search).get('view') || 'arena'

const defaultKeyboardShortcuts = {
  goToArena: { key: '1', ctrl: true },
  goToRunner: { key: '2', ctrl: true },
  goToModels: { key: '3', ctrl: true },
  goToBenchmarks: { key: '4', ctrl: true },
  goToResults: { key: '5', ctrl: true },
  goToStats: { key: '6', ctrl: true },
  goToSettings: { key: '7', ctrl: true },
  toggleSidebar: { key: 'b', ctrl: true },
  toggleRightPanel: { key: 'p', ctrl: true },
  closePanel: { key: 'Escape' },
}

window.localStorage.setItem('benchforge-ui', JSON.stringify({
  state: {
    sidebarCollapsed: false,
    activeView: view,
    selectedModelId: null,
    selectedBenchmarkId: null,
    rightPanelOpen: true,
    thinkingPanelOpen: false,
    theme: 'dark',
    language: 'en',
    keyboardShortcuts: defaultKeyboardShortcuts,
  },
  version: 3,
}))

const models = [
  { id: 1, name: 'GPT-4.1 Mini', mode: 'api', provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: null, model_id: 'gpt-4.1-mini', created_at: now },
  { id: 2, name: 'Qwen3 Local', mode: 'api', provider: 'lmstudio', base_url: 'http://localhost:1234/v1', api_key: null, model_id: 'qwen3-30b-a3b', created_at: now },
  { id: 3, name: 'Gemini 2.5', mode: 'api', provider: 'google-gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', api_key: null, model_id: 'gemini-2.5-pro', created_at: now },
]

const benchmarks = [
  { id: 1, name: 'HumanEval mini', category: 'Kod', description: 'Coding benchmark with sandbox-style checks.', suite_name: 'Code', prompt_template: 'Write a function that solves the task.', score_type: 'numeric', expected_answer: null, pass_condition: null, evaluation_checklist: ['Correct function', 'Passes tests'], evaluation_rubric: [], attempts: 1, output_type: 'text', reference_image: null, created_at: now },
  { id: 2, name: 'MMLU mini', category: 'Wiedza', description: 'Knowledge benchmark with short answers.', suite_name: 'Knowledge', prompt_template: 'Answer the question.', score_type: 'boolean', expected_answer: 'tak', pass_condition: 'Correct answer.', evaluation_checklist: ['Factual answer'], evaluation_rubric: [], attempts: 1, output_type: 'text', reference_image: null, created_at: now },
  { id: 3, name: 'Tool Agent', category: 'Kod', description: 'Agent benchmark using tools and artifacts.', suite_name: 'Agents', prompt_template: 'Use tools and return JSON.', score_type: 'numeric', expected_answer: null, pass_condition: null, evaluation_checklist: ['Uses tools', 'Returns final answer'], evaluation_rubric: [], attempts: 1, output_type: 'markdown', reference_image: null, created_at: now },
  { id: 4, name: 'Maze Path', category: 'Wizja', description: 'Vision / maze task with path validation.', suite_name: 'Vision', prompt_template: 'Solve the maze and save path artifacts.', score_type: 'numeric', expected_answer: null, pass_condition: null, evaluation_checklist: ['Valid path', 'Artifacts created'], evaluation_rubric: [], attempts: 1, output_type: 'maze', reference_image: null, created_at: now },
  { id: 5, name: 'Manual Rubric', category: 'Kreatywność', description: 'Qualitative manual grading benchmark.', suite_name: 'Manual', prompt_template: 'Answer according to the rubric.', score_type: 'numeric', expected_answer: null, pass_condition: null, evaluation_checklist: ['Helpful', 'Complete'], evaluation_rubric: [{ label: 'Clarity', points: 50, type: 'scale' }, { label: 'Completeness', points: 50, type: 'scale' }], attempts: 1, output_type: 'text', reference_image: null, created_at: now },
]

const tasks = benchmarks.map((benchmark) => ({
  id: benchmark.id,
  benchmark_id: benchmark.id,
  name: `${benchmark.name} task`,
  prompt_template: benchmark.prompt_template,
  score_type: benchmark.score_type,
  expected_answer: benchmark.expected_answer,
  pass_condition: benchmark.pass_condition,
  evaluation_checklist: benchmark.evaluation_checklist,
  evaluation_rubric: benchmark.evaluation_rubric,
  attempts: benchmark.attempts,
  order_index: 0,
  output_type: benchmark.output_type,
  reference_image: null,
  created_at: now,
}))

const results = [
  [1, 1, '92'], [1, 2, 'tak'], [1, 3, '88'], [1, 4, '75'], [1, 5, '84'],
  [2, 1, '96'], [2, 2, 'tak'], [2, 3, '91'], [2, 4, '82'], [2, 5, '78'],
  [3, 1, '89'], [3, 2, 'tak'], [3, 3, '94'], [3, 4, '86'], [3, 5, '90'],
].map(([modelId, benchmarkId, score], index) => ({
  id: index + 1,
  model_id: modelId,
  benchmark_id: benchmarkId,
  task_id: null,
  run_session_id: null,
  score: String(score),
  notes: 'Sample benchmark response for documentation screenshots.',
  thinking_notes: null,
  response_preview: 'Sample benchmark response for documentation screenshots.',
  artifact_path: null,
  attempt_number: 1,
  tokens_used: 1200 + index * 17,
  duration_ms: 1200 + index * 90,
  run_at: new Date(Date.now() - index * 3600_000).toISOString(),
}))

const runs = [
  { id: 1, name: 'Documentation sample run', started_at: now, finished_at: now, status: 'finished' },
]

contextBridge.exposeInMainWorld('db', {
  getModels: async () => models,
  getBenchmarks: async () => benchmarks,
  getResults: async () => results,
  getRuns: async () => runs,
  getPreference: async (key) => {
    if (key === 'onboarding_completed') return true
    if (key === 'repo_sandbox_roots') return []
    if (key === 'sandbox_use_docker') return false
    if (key === 'judge_model_id') return null
    return null
  },
  savePreference: async () => true,
  tasks: {
    get: async ({ benchmarkId }) => tasks.filter((task) => task.benchmark_id === benchmarkId),
    add: async () => null,
    update: async () => null,
    delete: async () => null,
    reorder: async () => null,
  },
  runSession: {
    getActive: async () => null,
    create: async () => null,
    update: async () => null,
    finish: async () => null,
    cancel: async () => null,
  },
  getDiscoveredModels: async () => [],
  addModel: async (payload) => ({ id: 99, created_at: now, ...payload }),
  updateModel: async (payload) => ({ id: payload.id, created_at: now, ...payload.data }),
  deleteModel: async () => true,
  addBenchmark: async (payload) => ({ id: 99, created_at: now, ...payload }),
  updateBenchmark: async (payload) => ({ id: payload.id, created_at: now, ...payload.data }),
  deleteBenchmark: async () => true,
  deleteResult: async () => true,
  clearResults: async () => true,
  rebuildResultArtifacts: async () => ({ created: 0 }),
  exportAll: async () => ({ models, benchmarks, tasks, results, runs }),
  clearAllData: async () => true,
  importAll: async () => true,
  testConnection: async () => ({ ok: true, error: null }),
  scanModels: async () => ({ lmstudio: ['qwen3-30b-a3b'], ollama: ['llama3.1'], vllm: ['meta-llama/Llama-3.1-8B-Instruct'], errors: {} }),
  sendPrompt: async () => ({ response: 'Sample response', tokens_used: 120 }),
  runBenchmark: async () => ({ response: 'Sample response', score: '92' }),
  runBenchmarkStreaming: async () => ({ started: true }),
  abortBenchmark: async () => ({ ok: true }),
  submitManualResult: async () => ({ ok: true }),
  submitManualStreaming: async () => ({ ok: true }),
  submitManualBatch: async () => ({ ok: true, results: [] }),
  onStreamEvent: () => undefined,
  removeStreamListeners: () => undefined,
})

contextBridge.exposeInMainWorld('benchforge', {
  getMeta: async () => ({ name: 'BenchForge', version: '1.0.0', platform: process.platform, dataPath: 'BenchForge/data' }),
  getDataPath: async () => 'BenchForge/data',
  openDataPath: async () => ({ ok: true }),
  openExternal: async () => ({ ok: true }),
  checkForUpdates: async () => ({ updateAvailable: false, currentVersion: '1.0.0' }),
  downloadUpdate: async () => ({ canceled: true }),
  applyPortableUpdate: async () => ({ ok: true }),
  saveJsonFile: async () => ({ canceled: true }),
  saveTextFile: async () => ({ canceled: true }),
  openJsonFile: async () => ({ canceled: true }),
  openPath: async () => ({ ok: true }),
  exportArtifactZip: async () => ({ canceled: true }),
  listBenchmarkPacks: async () => [],
  downloadBenchmarkPack: async () => null,
  scanBenchmarkBeacon: async () => null,
  discoverBenchmarkBeacons: async () => [],
  listTools: async () => [
    { id: 'python.run', name: 'Python Run', description: 'Run Python snippets in a sandbox.' },
    { id: 'node.run', name: 'Node Run', description: 'Run Node.js snippets in a sandbox.' },
    { id: 'image.draw_path_svg', name: 'Draw Path SVG', description: 'Create path overlay artifacts.' },
  ],
  runTool: async () => ({ ok: true }),
  checkEnvironment: async () => ({ checks: [] }),
  healthCheck: async () => ({ ok: true, checks: [] }),
  getMcpServers: async () => [],
  saveMcpServers: async () => [],
  listMcpTools: async () => [],
  callMcpTool: async () => ({ ok: true }),
  judgeEvaluate: async () => ({ ok: true, result: { score: 90, passed: true, reason: 'Sample' } }),
})
