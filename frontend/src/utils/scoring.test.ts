// ============================================================
// Testy dla utils/scoring.ts
// ============================================================

import { describe, it, expect } from 'vitest'
import { normalizeScore } from '@/utils/scoring'

describe('normalizeScore', () => {
  describe('boolean score type', () => {
    it('returns 1 for matching expected answer', () => {
      expect(normalizeScore('tak', 'boolean', 'tak')).toBe(1)
      expect(normalizeScore('nie', 'boolean', 'nie')).toBe(1)
    })

    it('returns 0 for non-matching expected answer', () => {
      expect(normalizeScore('tak', 'boolean', 'nie')).toBe(0)
      expect(normalizeScore('nie', 'boolean', 'tak')).toBe(0)
    })

    it('defaults to "tak" as expected answer', () => {
      expect(normalizeScore('tak', 'boolean')).toBe(1)
      expect(normalizeScore('nie', 'boolean')).toBe(0)
    })

    it('handles case insensitive input', () => {
      expect(normalizeScore('TAK', 'boolean', 'tak')).toBe(1)
      expect(normalizeScore('Nie', 'boolean', 'nie')).toBe(1)
    })

    it('considers attempt number for scoring', () => {
      // With 3 attempts, first attempt gives full score
      expect(normalizeScore('tak', 'boolean', 'tak', 1, 3)).toBe(1)
      // Second attempt gives 2/3
      expect(normalizeScore('tak', 'boolean', 'tak', 2, 3)).toBeCloseTo(0.667, 2)
      // Third attempt gives 1/3
      expect(normalizeScore('tak', 'boolean', 'tak', 3, 3)).toBeCloseTo(0.333, 2)
    })
  })

  describe('numeric score type', () => {
    it('returns percentage as decimal', () => {
      expect(normalizeScore('100', 'numeric')).toBe(1)
      expect(normalizeScore('50', 'numeric')).toBe(0.5)
      expect(normalizeScore('0', 'numeric')).toBe(0)
    })

    it('clamps values to 0-1 range', () => {
      expect(normalizeScore('150', 'numeric')).toBe(1)
      expect(normalizeScore('-10', 'numeric')).toBe(0)
    })

    it('handles non-numeric input', () => {
      expect(normalizeScore('abc', 'numeric')).toBe(0)
      expect(normalizeScore('', 'numeric')).toBe(0)
    })

    it('handles percentage symbol', () => {
      expect(normalizeScore('75%', 'numeric')).toBe(0)
    })
  })
})
