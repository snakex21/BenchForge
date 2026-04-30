// ============================================================
// Testy dla components/ui/Card.tsx
// ============================================================

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Card } from '@/components/ui/Card'

describe('Card', () => {
  it('renders children', () => {
    render(<Card>Content</Card>)
    expect(screen.getByText('Content')).toBeInTheDocument()
  })

  it('renders title when provided', () => {
    render(<Card title="Test Title">Content</Card>)
    expect(screen.getByText('Test Title')).toBeInTheDocument()
  })

  it('renders subtitle when provided', () => {
    render(<Card title="Title" subtitle="Test Subtitle">Content</Card>)
    expect(screen.getByText('Test Subtitle')).toBeInTheDocument()
  })

  it('does not render title/subtitle when not provided', () => {
    const { container } = render(<Card>Content</Card>)
    const header = container.querySelector('.border-b')
    expect(header).toBeNull()
  })

  it('applies padding by default', () => {
    const { container } = render(<Card>Content</Card>)
    const content = container.querySelector('.p-4')
    expect(content).toBeInTheDocument()
  })

  it('removes padding when padding=false', () => {
    const { container } = render(<Card padding={false}>Content</Card>)
    const content = container.querySelector('.p-4')
    expect(content).toBeNull()
  })

  it('applies custom className', () => {
    const { container } = render(<Card className="custom-class">Content</Card>)
    expect((container.firstElementChild as HTMLElement | null)?.className).toContain('custom-class')
  })
})
