// ============================================================
// Testy dla store/uiStore.ts
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from '@/store/uiStore'

describe('uiStore', () => {
  beforeEach(() => {
    // Reset store before each test
    useUIStore.setState({
      sidebarCollapsed: false,
      activeView: 'arena',
      selectedModelId: null,
      selectedBenchmarkId: null,
      rightPanelOpen: true,
      thinkingPanelOpen: false,
      theme: 'dark',
      language: 'en',
      rerunTarget: null,
    })
  })

  describe('sidebar', () => {
    it('toggles sidebar collapsed state', () => {
      expect(useUIStore.getState().sidebarCollapsed).toBe(false)
      useUIStore.getState().toggleSidebar()
      expect(useUIStore.getState().sidebarCollapsed).toBe(true)
      useUIStore.getState().toggleSidebar()
      expect(useUIStore.getState().sidebarCollapsed).toBe(false)
    })

    it('sets sidebar collapsed directly', () => {
      useUIStore.getState().setSidebarCollapsed(true)
      expect(useUIStore.getState().sidebarCollapsed).toBe(true)
    })
  })

  describe('active view', () => {
    it('sets active view', () => {
      useUIStore.getState().setActiveView('models')
      expect(useUIStore.getState().activeView).toBe('models')
    })

    it('changes between views', () => {
      useUIStore.getState().setActiveView('runner')
      expect(useUIStore.getState().activeView).toBe('runner')
      useUIStore.getState().setActiveView('settings')
      expect(useUIStore.getState().activeView).toBe('settings')
    })
  })

  describe('selection', () => {
    it('selects model', () => {
      useUIStore.getState().selectModel(42)
      expect(useUIStore.getState().selectedModelId).toBe(42)
    })

    it('deselects model', () => {
      useUIStore.getState().selectModel(42)
      useUIStore.getState().selectModel(null)
      expect(useUIStore.getState().selectedModelId).toBe(null)
    })

    it('selects benchmark and opens panel', () => {
      useUIStore.getState().selectBenchmark(10)
      expect(useUIStore.getState().selectedBenchmarkId).toBe(10)
      expect(useUIStore.getState().rightPanelOpen).toBe(true)
    })
  })

  describe('theme', () => {
    it('sets theme', () => {
      useUIStore.getState().setTheme('cyberpunk')
      expect(useUIStore.getState().theme).toBe('cyberpunk')
    })
  })

  describe('keyboard shortcuts', () => {
    it('has default keyboard shortcuts', () => {
      const shortcuts = useUIStore.getState().keyboardShortcuts
      expect(shortcuts.goToArena).toEqual({ key: '1', ctrl: true })
      expect(shortcuts.goToRunner).toEqual({ key: '2', ctrl: true })
      expect(shortcuts.toggleSidebar).toEqual({ key: 'b', ctrl: true })
      expect(shortcuts.closePanel).toEqual({ key: 'Escape' })
    })

    it('updates keyboard shortcuts', () => {
      useUIStore.getState().setKeyboardShortcuts({
        goToArena: { key: 'a', ctrl: true, alt: true },
      })
      const shortcuts = useUIStore.getState().keyboardShortcuts
      expect(shortcuts.goToArena).toEqual({ key: 'a', ctrl: true, alt: true })
      // Other shortcuts should remain unchanged
      expect(shortcuts.goToRunner).toEqual({ key: '2', ctrl: true })
    })

    it('resets keyboard shortcuts to defaults', () => {
      useUIStore.getState().setKeyboardShortcuts({
        goToArena: { key: 'x' },
      })
      useUIStore.getState().resetKeyboardShortcuts()
      const shortcuts = useUIStore.getState().keyboardShortcuts
      expect(shortcuts.goToArena).toEqual({ key: '1', ctrl: true })
    })
  })
})
