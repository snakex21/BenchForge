// ============================================================
// Testy dla components/ui/Badge.tsx
// ============================================================

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge } from '@/components/ui/Badge'

describe('Badge', () => {
  it('renders children', () => {
    render(<Badge>Test</Badge>)
    expect(screen.getByText('Test')).toBeInTheDocument()
  })

  it('applies default variant (neutral)', () => {
    const { container } = render(<Badge>Default</Badge>)
    expect((container.firstElementChild as HTMLElement | null)?.className).toContain('bg-slate-500')
  })

  it('applies info variant', () => {
    const { container } = render(<Badge variant="info">Info</Badge>)
    expect((container.firstElementChild as HTMLElement | null)?.className).toContain('bg-indigo-500')
  })

  it('applies success variant', () => {
    const { container } = render(<Badge variant="success">Success</Badge>)
    expect((container.firstElementChild as HTMLElement | null)?.className).toContain('bg-emerald-500')
  })

  it('applies warning variant', () => {
    const { container } = render(<Badge variant="warning">Warning</Badge>)
    expect((container.firstElementChild as HTMLElement | null)?.className).toContain('bg-amber-500')
  })

  it('applies danger variant', () => {
    const { container } = render(<Badge variant="danger">Danger</Badge>)
    expect((container.firstElementChild as HTMLElement | null)?.className).toContain('bg-red-500')
  })

  it('applies custom className', () => {
    const { container } = render(<Badge className="custom-class">Custom</Badge>)
    expect((container.firstElementChild as HTMLElement | null)?.className).toContain('custom-class')
  })
})
