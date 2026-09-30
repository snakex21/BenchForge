import type { AIModel, Benchmark, BenchmarkResult, BenchmarkRun, Task } from '@/types'

export interface SnapshotMeta {
  version: 'benchforge-readonly-snapshot-v1'
  read_only: true
  label: string
  source_kind: 'synthetic' | 'copied-export'
  evaluator_origin: string
  snapshot_sha256: string
  capabilities: string[]
}
export interface ReadOnlyTransport {
  getMeta(): Promise<SnapshotMeta>
  getModels(): Promise<AIModel[]>
  getBenchmarks(): Promise<Benchmark[]>
  tasks: { get(payload: { benchmarkId: number }): Promise<Task[]> }
  getResults(): Promise<BenchmarkResult[]>
  getRuns(): Promise<BenchmarkRun[]>
}
// Six explicit read contracts; no Electron globals or mutation-success stubs.
export function createReadOnlyTransport(signal?: AbortSignal): ReadOnlyTransport {
  async function read<T>(route: string): Promise<T> {
    const response = await fetch(`/api/readonly/${route}`, { method: 'GET', signal, credentials: 'same-origin' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || `Read-only API error: ${response.status}`)
    return body as T
  }
  return {
    async getMeta() {
      const meta = await read<SnapshotMeta>('meta')
      if (meta.version !== 'benchforge-readonly-snapshot-v1' || meta.read_only !== true) throw new Error('Unsupported or writable snapshot backend')
      return meta
    },
    getModels: () => read<AIModel[]>('models'),
    getBenchmarks: () => read<Benchmark[]>('benchmarks'),
    tasks: { get: ({ benchmarkId }) => read<Task[]>(`tasks?benchmark_id=${encodeURIComponent(benchmarkId)}`) },
    getResults: () => read<BenchmarkResult[]>('results'),
    getRuns: () => read<BenchmarkRun[]>('runs'),
  }
}
