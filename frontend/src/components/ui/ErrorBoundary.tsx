// ============================================================
// ErrorBoundary — łapie błędy w drzewie komponentów
// Zamiast białego ekranu — ładny komunikat
// ============================================================

import { Component, type ErrorInfo, type FC, type ReactNode } from 'react'
import { useTranslation } from '@/i18n'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

const DefaultErrorFallback: FC<{ error: Error | null; onReset: () => void; onReload: () => void }> = ({ error, onReset, onReload }) => {
  const { t } = useTranslation()

  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="text-4xl">💥</span>
      <div>
        <h2 className="text-lg font-semibold text-slate-200">
          {t('errorBoundary.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {t('errorBoundary.description')}
        </p>
      </div>
      {error && (
        <details className="max-w-md rounded-lg border border-slate-700/40 bg-slate-950/50 p-3 text-left">
          <summary className="cursor-pointer text-xs text-slate-500">
            {t('errorBoundary.details')}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-red-400">
            {error.message}
          </pre>
        </details>
      )}
      <div className="flex gap-2">
        <button
          onClick={onReset}
          className="rounded-lg border border-slate-600/50 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
        >
          {t('errorBoundary.tryAgain')}
        </button>
        <button
          onClick={onReload}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white transition hover:bg-indigo-500"
        >
          {t('errorBoundary.reload')}
        </button>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return <DefaultErrorFallback error={this.state.error} onReset={this.handleReset} onReload={this.handleReload} />
    }

    return this.props.children
  }
}
