import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ActiveView, KeyboardShortcuts, UIState } from '@/types'

const detectInitialLanguage = (): UIState['language'] => {
  if (typeof navigator === 'undefined') return 'en'
  const preferred = (navigator.languages?.[0] || navigator.language || '').toLowerCase()
  if (preferred.startsWith('zh-tw') || preferred.startsWith('zh-hk') || preferred.startsWith('zh-mo')) return 'zh-TW'
  const detected = ['pl', 'en', 'de', 'es', 'fr', 'it', 'pt', 'uk', 'cs', 'nl', 'tr', 'ja', 'ru', 'zh', 'ko', 'id', 'vi', 'th', 'hi', 'ar', 'he', 'el', 'sv', 'no', 'nb', 'nn', 'da', 'fi', 'hu', 'ro', 'bg', 'hr', 'sk', 'sl', 'lt', 'lv', 'et', 'sr', 'ca', 'eu', 'gl', 'ga', 'cy', 'is', 'mt', 'sq', 'mk', 'be', 'bs', 'lb', 'gd', 'br', 'co', 'fy', 'fa', 'ur', 'ms', 'fil', 'bn'].find((language) => preferred.startsWith(language))
  if (detected === 'nb' || detected === 'nn') return 'no'
  if (detected) return detected as UIState['language']
  return 'en'
}

const supportedLanguages: UIState['language'][] = ['pl', 'en', 'de', 'es', 'fr', 'it', 'pt', 'uk', 'cs', 'nl', 'tr', 'ja', 'ru', 'zh', 'zh-TW', 'ko', 'id', 'vi', 'th', 'hi', 'ar', 'he', 'el', 'sv', 'no', 'da', 'fi', 'hu', 'ro', 'bg', 'hr', 'sk', 'sl', 'lt', 'lv', 'et', 'sr', 'ca', 'eu', 'gl', 'ga', 'cy', 'is', 'mt', 'sq', 'mk', 'be', 'bs', 'lb', 'gd', 'br', 'co', 'fy', 'fa', 'ur', 'ms', 'fil', 'bn']

const defaultKeyboardShortcuts: KeyboardShortcuts = {
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

interface UIStore extends UIState {
  setSidebarCollapsed: (collapsed: boolean) => void
  setActiveView: (view: ActiveView) => void
  selectModel: (modelId: number | null) => void
  selectBenchmark: (benchmarkId: number | null) => void
  setRightPanelOpen: (open: boolean) => void
  setThinkingPanelOpen: (open: boolean) => void
  setTheme: (theme: UIState['theme']) => void
  setLanguage: (language: UIState['language']) => void
  setRerunTarget: (target: { modelId: number; benchmarkId: number; taskIds?: number[] } | null) => void
  setKeyboardShortcuts: (shortcuts: Partial<KeyboardShortcuts>) => void
  resetKeyboardShortcuts: () => void

  toggleSidebar: () => void
}

const defaultUIState: UIState = {
  sidebarCollapsed: false,
  activeView: 'arena',
  selectedModelId: null,
  selectedBenchmarkId: null,
  rightPanelOpen: true,
  thinkingPanelOpen: false,
  theme: 'dark',
  language: detectInitialLanguage(),
  rerunTarget: null,
  keyboardShortcuts: defaultKeyboardShortcuts,
}

const sanitizeUIState = (state: unknown): UIState => {
  const persisted = (state ?? {}) as Partial<UIState>
  const validViews: ActiveView[] = ['arena', 'runner', 'models', 'benchmarks', 'results', 'stats', 'settings']

  const sanitizeShortcuts = (shortcuts: unknown): KeyboardShortcuts => {
    if (!shortcuts || typeof shortcuts !== 'object') return defaultKeyboardShortcuts
    const partial = shortcuts as Partial<KeyboardShortcuts>
    const result: Record<string, unknown> = {}
    for (const [key, defaultValue] of Object.entries(defaultKeyboardShortcuts)) {
      const value = partial[key as keyof KeyboardShortcuts]
      if (value && typeof value === 'object' && 'key' in value) {
        result[key] = {
          key: String(value.key || defaultValue.key),
          ctrl: typeof value.ctrl === 'boolean' ? value.ctrl : defaultValue.ctrl,
          alt: typeof value.alt === 'boolean' ? value.alt : defaultValue.alt,
          shift: typeof value.shift === 'boolean' ? value.shift : defaultValue.shift,
          meta: typeof value.meta === 'boolean' ? value.meta : defaultValue.meta,
        }
      } else {
        result[key] = defaultValue
      }
    }
    return result as unknown as KeyboardShortcuts
  }

  return {
    sidebarCollapsed: typeof persisted.sidebarCollapsed === 'boolean' ? persisted.sidebarCollapsed : defaultUIState.sidebarCollapsed,
    activeView: validViews.includes(persisted.activeView as ActiveView) ? (persisted.activeView as ActiveView) : defaultUIState.activeView,
    selectedModelId: typeof persisted.selectedModelId === 'number' || persisted.selectedModelId === null ? persisted.selectedModelId : defaultUIState.selectedModelId,
    selectedBenchmarkId: typeof persisted.selectedBenchmarkId === 'number' || persisted.selectedBenchmarkId === null ? persisted.selectedBenchmarkId : defaultUIState.selectedBenchmarkId,
    rightPanelOpen: typeof persisted.rightPanelOpen === 'boolean' ? persisted.rightPanelOpen : defaultUIState.rightPanelOpen,
    thinkingPanelOpen: typeof persisted.thinkingPanelOpen === 'boolean' ? persisted.thinkingPanelOpen : defaultUIState.thinkingPanelOpen,
    theme: ['dark', 'light', 'cyberpunk', 'graphite'].includes(String(persisted.theme)) ? (persisted.theme as UIState['theme']) : defaultUIState.theme,
    language: supportedLanguages.includes(persisted.language as UIState['language']) ? (persisted.language as UIState['language']) : defaultUIState.language,
    rerunTarget: persisted.rerunTarget && typeof persisted.rerunTarget === 'object' && 'modelId' in persisted.rerunTarget && 'benchmarkId' in persisted.rerunTarget ? persisted.rerunTarget as { modelId: number; benchmarkId: number; taskIds?: number[] } : null,
    keyboardShortcuts: sanitizeShortcuts(persisted.keyboardShortcuts),
  }
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      ...defaultUIState,

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      setActiveView: (view) => set({ activeView: view }),

      selectModel: (modelId) => set({ selectedModelId: modelId }),

      selectBenchmark: (benchmarkId) => set({ selectedBenchmarkId: benchmarkId, rightPanelOpen: true }),

      setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
      setThinkingPanelOpen: (open) => set({ thinkingPanelOpen: open }),
      setTheme: (theme) => { document.documentElement.dataset.theme = theme; set({ theme }) },
      setLanguage: (language) => set({ language }),
      setRerunTarget: (target) => set({ rerunTarget: target }),
      setKeyboardShortcuts: (shortcuts) => set((state) => ({
        keyboardShortcuts: { ...state.keyboardShortcuts, ...shortcuts },
      })),
      resetKeyboardShortcuts: () => set({ keyboardShortcuts: defaultKeyboardShortcuts }),
    }),
    {
      name: 'benchforge-ui',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState) => sanitizeUIState(persistedState),
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        activeView: state.activeView,
        selectedModelId: state.selectedModelId,
        selectedBenchmarkId: state.selectedBenchmarkId,
        rightPanelOpen: state.rightPanelOpen,
        thinkingPanelOpen: state.thinkingPanelOpen,
        theme: state.theme,
        language: state.language,
        keyboardShortcuts: state.keyboardShortcuts,
      }),
    }
  )
)
