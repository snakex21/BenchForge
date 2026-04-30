// ============================================================
// useKeyboardShortcuts — globalny hook dla skrótów klawiszowych
// ============================================================

import { useEffect, useCallback } from 'react'
import { useUIStore } from '@/store/uiStore'
import type { KeyboardShortcut, KeyboardAction } from '@/types'

const matchesShortcut = (event: KeyboardEvent, shortcut: KeyboardShortcut): boolean => {
  const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase()
  const ctrlMatch = shortcut.ctrl ? (event.ctrlKey || event.metaKey) : !(event.ctrlKey || event.metaKey)
  const altMatch = shortcut.alt ? event.altKey : !event.altKey
  const shiftMatch = shortcut.shift ? event.shiftKey : !event.shiftKey
  const metaMatch = shortcut.meta ? event.metaKey : true // meta is optional, ctrl covers it

  return keyMatch && ctrlMatch && altMatch && shiftMatch && metaMatch
}

const ACTION_HANDLERS: Record<KeyboardAction, () => void> = {
  goToArena: () => useUIStore.getState().setActiveView('arena'),
  goToRunner: () => useUIStore.getState().setActiveView('runner'),
  goToModels: () => useUIStore.getState().setActiveView('models'),
  goToBenchmarks: () => useUIStore.getState().setActiveView('benchmarks'),
  goToResults: () => useUIStore.getState().setActiveView('results'),
  goToStats: () => useUIStore.getState().setActiveView('stats'),
  goToSettings: () => useUIStore.getState().setActiveView('settings'),
  toggleSidebar: () => useUIStore.getState().toggleSidebar(),
  toggleRightPanel: () => {
    const state = useUIStore.getState()
    state.setRightPanelOpen(!state.rightPanelOpen)
  },
  closePanel: () => {
    const state = useUIStore.getState()
    if (state.selectedModelId !== null) {
      state.selectModel(null)
    } else if (state.selectedBenchmarkId !== null) {
      state.selectBenchmark(null)
    }
    state.setRightPanelOpen(false)
  },
}

export const useKeyboardShortcuts = () => {
  const shortcuts = useUIStore((state) => state.keyboardShortcuts)

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Don't trigger shortcuts when typing in inputs
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) {
      return
    }

    for (const [action, shortcut] of Object.entries(shortcuts)) {
      if (matchesShortcut(event, shortcut)) {
        const handler = ACTION_HANDLERS[action as KeyboardAction]
        if (handler) {
          event.preventDefault()
          event.stopPropagation()
          handler()
          return
        }
      }
    }
  }, [shortcuts])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

export const formatShortcut = (shortcut: KeyboardShortcut): string => {
  const parts: string[] = []
  if (shortcut.ctrl) parts.push('Ctrl')
  if (shortcut.alt) parts.push('Alt')
  if (shortcut.shift) parts.push('Shift')
  if (shortcut.meta) parts.push('⌘')

  // Format key name
  let keyName = shortcut.key
  if (keyName === 'Escape') keyName = 'Esc'
  else if (keyName === ' ') keyName = 'Space'
  else if (keyName.length === 1) keyName = keyName.toUpperCase()

  parts.push(keyName)
  return parts.join(' + ')
}
