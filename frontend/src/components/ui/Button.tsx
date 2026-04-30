// ============================================================
// Button — przycisk z wariantami i stanem ładowania
// ============================================================

import React from 'react'

export interface ButtonProps {
  children: React.ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  isLoading?: boolean
  onClick?: () => void
  className?: string
}

const VARIANT_CLASSES: Record<string, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700 shadow-sm',
  secondary:
    'bg-slate-700/60 text-slate-200 hover:bg-slate-600/80 border border-slate-600/50',
  ghost: 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/40',
  danger: 'bg-red-600/80 text-white hover:bg-red-500 active:bg-red-700',
}

const SIZE_CLASSES: Record<string, string> = {
  sm: 'px-2.5 py-1 text-xs rounded-md',
  md: 'px-3.5 py-1.5 text-sm rounded-lg',
  lg: 'px-5 py-2.5 text-base rounded-xl',
}

export const Button: React.FC<ButtonProps> = React.memo(({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled = false,
  isLoading = false,
  onClick,
  className = '',
}) => {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || isLoading}
      className={`
        inline-flex items-center justify-center gap-2 font-medium
        transition-all duration-150 ease-out
        cursor-pointer select-none
        disabled:opacity-40 disabled:cursor-not-allowed
        active:scale-[0.97]
        ${VARIANT_CLASSES[variant]}
        ${SIZE_CLASSES[size]}
        ${className}
      `}
    >
      {isLoading && (
        <svg
          className="h-4 w-4 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
            className="opacity-30"
          />
          <path
            d="M12 2a10 10 0 0 1 10 10"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      )}
      {children}
    </button>
  )
})

Button.displayName = 'Button'
