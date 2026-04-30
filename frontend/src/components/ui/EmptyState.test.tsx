// ============================================================
// Testy dla components/ui/EmptyState.tsx
// ============================================================

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EmptyState } from '@/components/ui/EmptyState'

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(<EmptyState title="No data" description="Add some items" />)
    expect(screen.getByText('No data')).toBeInTheDocument()
    expect(screen.getByText('Add some items')).toBeInTheDocument()
  })

  it('renders default icon', () => {
    render(<EmptyState title="Title" description="Desc" />)
    expect(screen.getByText('📭')).toBeInTheDocument()
  })

  it('renders custom icon', () => {
    render(<EmptyState icon="search" title="Title" description="Desc" />)
    expect(screen.getByText('🔍')).toBeInTheDocument()
  })

  it('renders action button when provided', () => {
    render(
      <EmptyState
        title="Title"
        description="Desc"
        actionLabel="Add item"
        onAction={() => {}}
      />
    )
    expect(screen.getByText('Add item')).toBeInTheDocument()
  })

  it('does not render action button when not provided', () => {
    render(<EmptyState title="Title" description="Desc" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('calls onAction when button is clicked', () => {
    let clicked = false
    render(
      <EmptyState
        title="Title"
        description="Desc"
        actionLabel="Click me"
        onAction={() => { clicked = true }}
      />
    )
    fireEvent.click(screen.getByText('Click me'))
    expect(clicked).toBe(true)
  })
})
