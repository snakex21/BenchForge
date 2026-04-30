// ============================================================
// Testy dla components/ui/Button.tsx
// ============================================================

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Button } from '@/components/ui/Button'

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByText('Click me')).toBeInTheDocument()
  })

  it('calls onClick when clicked', () => {
    let clicked = false
    render(<Button onClick={() => { clicked = true }}>Click</Button>)
    fireEvent.click(screen.getByText('Click'))
    expect(clicked).toBe(true)
  })

  it('does not call onClick when disabled', () => {
    let clicked = false
    render(<Button disabled onClick={() => { clicked = true }}>Click</Button>)
    fireEvent.click(screen.getByText('Click'))
    expect(clicked).toBe(false)
  })

  it('does not call onClick when loading', () => {
    let clicked = false
    render(<Button isLoading onClick={() => { clicked = true }}>Click</Button>)
    fireEvent.click(screen.getByText('Click'))
    expect(clicked).toBe(false)
  })

  it('applies variant classes', () => {
    const { container } = render(<Button variant="danger">Delete</Button>)
    expect(container.firstChild?.className).toContain('bg-red-600')
  })

  it('applies size classes', () => {
    const { container } = render(<Button size="lg">Large</Button>)
    expect(container.firstChild?.className).toContain('px-5')
  })

  it('shows loading spinner when isLoading', () => {
    render(<Button isLoading>Loading</Button>)
    expect(screen.getByText('Loading')).toBeInTheDocument()
    // Check for spinner SVG
    const svg = document.querySelector('svg.animate-spin')
    expect(svg).toBeInTheDocument()
  })
})
