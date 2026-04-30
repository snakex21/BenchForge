// ============================================================
// Testy dla hooks/useKeyboardShortcuts.ts
// ============================================================

import { describe, it, expect } from 'vitest'
import { formatShortcut } from '@/hooks/useKeyboardShortcuts'
import type { KeyboardShortcut } from '@/types'

describe('formatShortcut', () => {
  it('formats simple key', () => {
    const shortcut: KeyboardShortcut = { key: 'a' }
    expect(formatShortcut(shortcut)).toBe('A')
  })

  it('formats key with ctrl', () => {
    const shortcut: KeyboardShortcut = { key: '1', ctrl: true }
    expect(formatShortcut(shortcut)).toBe('Ctrl + 1')
  })

  it('formats key with alt', () => {
    const shortcut: KeyboardShortcut = { key: 'F4', alt: true }
    expect(formatShortcut(shortcut)).toBe('Alt + F4')
  })

  it('formats key with shift', () => {
    const shortcut: KeyboardShortcut = { key: 'a', shift: true }
    expect(formatShortcut(shortcut)).toBe('Shift + A')
  })

  it('formats key with multiple modifiers', () => {
    const shortcut: KeyboardShortcut = { key: 'z', ctrl: true, shift: true }
    expect(formatShortcut(shortcut)).toBe('Ctrl + Shift + Z')
  })

  it('formats Escape key', () => {
    const shortcut: KeyboardShortcut = { key: 'Escape' }
    expect(formatShortcut(shortcut)).toBe('Esc')
  })

  it('formats Space key', () => {
    const shortcut: KeyboardShortcut = { key: ' ' }
    expect(formatShortcut(shortcut)).toBe('Space')
  })

  it('formats key with meta (⌘)', () => {
    const shortcut: KeyboardShortcut = { key: 'c', meta: true }
    expect(formatShortcut(shortcut)).toBe('⌘ + C')
  })
})
