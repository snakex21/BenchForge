// ============================================================
// Zustand store — provider configs (API key per provider)
// ============================================================

import { create } from 'zustand'
import type { ProviderConfig } from '@/types'

interface ProviderConfigSlice {
  configs: ProviderConfig[]
  isLoading: boolean
  loadFromDb: () => Promise<void>
  saveConfig: (provider: string, data: { api_key?: string | null; base_url?: string | null; display_name?: string | null; icon_url?: string | null; is_custom?: boolean }) => Promise<ProviderConfig | null>
  deleteConfig: (provider: string) => Promise<void>
  getConfig: (provider: string) => ProviderConfig | undefined
}

export const useProviderConfigStore = create<ProviderConfigSlice>((set, get) => ({
  configs: [],
  isLoading: false,

  loadFromDb: async () => {
    if (!window.db?.providerConfigs) {
      set({ configs: [], isLoading: false })
      return
    }

    set({ isLoading: true })
    const configs = await window.db.providerConfigs.getAll()
    set({ configs, isLoading: false })
  },

  saveConfig: async (provider, data) => {
    if (!window.db?.providerConfigs) return null

    const saved = await window.db.providerConfigs.save(provider, data)
    if (!saved) return null

    set((state) => {
      const existing = state.configs.findIndex((c) => c.provider === provider)
      if (existing >= 0) {
        const updated = [...state.configs]
        updated[existing] = saved
        return { configs: updated }
      }
      return { configs: [...state.configs, saved] }
    })

    return saved
  },

  deleteConfig: async (provider) => {
    if (!window.db?.providerConfigs) return
    await window.db.providerConfigs.delete(provider)
    set((state) => ({
      configs: state.configs.filter((c) => c.provider !== provider),
    }))
  },

  getConfig: (provider) => {
    return get().configs.find((c) => c.provider === provider)
  },
}))
