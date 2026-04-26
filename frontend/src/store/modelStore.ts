// ============================================================
// Zustand store — modele AI
// ============================================================

import { create } from 'zustand'
import type { AIModel } from '@/types'
import { useResultStore } from './resultStore'
import { useUIStore } from './uiStore'

type ModelInput = Omit<AIModel, 'id' | 'created_at'>

interface ModelSlice {
  models: AIModel[]
  isLoading: boolean
  loadFromDb: () => Promise<void>
  addModel: (model: ModelInput) => Promise<void>
  updateModel: (id: number, patch: Partial<ModelInput>) => Promise<void>
  removeModel: (id: number) => Promise<void>
}

export const useModelStore = create<ModelSlice>((set) => ({
  models: [],
  isLoading: false,

  loadFromDb: async () => {
    if (!window.db) {
      set({ models: [], isLoading: false })
      return
    }

    set({ isLoading: true })
    const models = await window.db.getModels()
    set({ models, isLoading: false })
  },

  addModel: async (model) => {
    if (!window.db) return

    const created = await window.db.addModel(model)
    set((state) => ({
      models: [created, ...state.models],
    }))
  },

  updateModel: async (id, patch) => {
    if (!window.db) return

    const updated = await window.db.updateModel({ id, data: patch })
    if (!updated) return

    set((state) => ({
      models: state.models.map((model) => (model.id === id ? updated : model)),
    }))
  },

  removeModel: async (id) => {
    if (!window.db) return

    await window.db.deleteModel({ id })
    set((state) => ({
      models: state.models.filter((model) => model.id !== id),
    }))

    if (useUIStore.getState().selectedModelId === id) {
      useUIStore.getState().selectModel(null)
    }

    await useResultStore.getState().loadFromDb()
  },
}))
