// ============================================================
// Zustand store — wyniki benchmarków i historia uruchomień
// ============================================================

import { create } from 'zustand'
import type { BenchmarkResult, BenchmarkRun } from '@/types'

type ResultInput = Omit<BenchmarkResult, 'id'>
type RunInput = Omit<BenchmarkRun, 'id'>

interface ResultSlice {
  results: BenchmarkResult[]
  runs: BenchmarkRun[]
  isLoading: boolean
  loadFromDb: () => Promise<void>
  addResult: (result: ResultInput) => Promise<void>
  removeResult: (id: number) => Promise<void>
  clearResults: () => Promise<void>
  addRun: (run: RunInput) => Promise<void>
  updateRun: (id: number, patch: Partial<RunInput>) => Promise<void>
}

export const useResultStore = create<ResultSlice>((set, get) => ({
  results: [],
  runs: [],
  isLoading: false,

  loadFromDb: async () => {
    if (!window.db) {
      set({ results: [], runs: [], isLoading: false })
      return
    }

    set({ isLoading: true })
    const [results, runs] = await Promise.all([window.db.getResults(), window.db.getRuns()])
    set({ results, runs, isLoading: false })
  },

  addResult: async (result) => {
    if (!window.db) return

    const created = await window.db.addResult(result)
    set((state) => ({
      results: [created, ...state.results],
    }))
  },

  removeResult: async (id) => {
    if (!window.db) return

    await window.db.deleteResult({ id })
    set((state) => ({
      results: state.results.filter((result) => result.id !== id),
    }))
  },

  clearResults: async () => {
    const db = window.db
    if (!db) return

    if (db.clearResults) {
      const cleared = await db.clearResults()
      set({ results: cleared.results || [], runs: cleared.runs || [] })
      return
    }

    const resultIds = get().results.map((result) => result.id)
    await Promise.all(resultIds.map((id) => db.deleteResult({ id })))
    set({ results: [], runs: [] })
  },

  addRun: async (run) => {
    if (!window.db) return

    const created = await window.db.addRun(run)
    set((state) => ({
      runs: [created, ...state.runs],
    }))
  },

  updateRun: async (id, patch) => {
    if (!window.db) return

    const updated = await window.db.updateRun({ id, data: patch })
    set((state) => ({
      runs: state.runs.map((run) => (run.id === id ? updated : run)),
    }))
  },
}))
