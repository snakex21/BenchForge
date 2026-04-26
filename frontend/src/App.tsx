// ============================================================
// App.tsx — główny komponent aplikacji z routingiem widoków
// ============================================================

import { useEffect, useState } from 'react'
import { useUIStore } from '@/store/uiStore'
import { useModelStore } from '@/store/modelStore'
import { useBenchmarkStore } from '@/store/benchmarkStore'
import { useResultStore } from '@/store/resultStore'
import { AppLayout } from '@/components/layout/AppLayout'
import { DetailsPanel } from '@/components/benchmark/DetailsPanel'
import { ArenaView } from '@/features/arena/ArenaView'
import { RunnerView } from '@/features/arena/RunnerView'
import { ModelsView } from '@/features/arena/ModelsView'
import { BenchmarksView } from '@/features/arena/BenchmarksView'
import { ResultsView } from '@/features/arena/ResultsView'
import { StatsView } from '@/features/arena/StatsView'
import { SettingsView } from '@/features/arena/SettingsView'
import { useTranslation } from '@/i18n'

function App() {
  const activeView = useUIStore((state) => state.activeView)
  const selectedModelId = useUIStore((state) => state.selectedModelId)
  const selectedBenchmarkId = useUIStore((state) => state.selectedBenchmarkId)
  const theme = useUIStore((state) => state.theme)
  const language = useUIStore((state) => state.language)
  const loadModels = useModelStore((state) => state.loadFromDb)
  const loadBenchmarks = useBenchmarkStore((state) => state.loadFromDb)
  const loadResults = useResultStore((state) => state.loadFromDb)
  const { t } = useTranslation()
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  useEffect(() => {
    const bootstrap = async () => {
      await Promise.all([loadModels(), loadBenchmarks(), loadResults()])
      setIsReady(true)
    }

    void bootstrap()
  }, [loadModels, loadBenchmarks, loadResults])

  const renderView = () => {
    switch (activeView) {
      case 'arena':
        return <ArenaView />
      case 'models':
        return <ModelsView />
      case 'benchmarks':
        return <BenchmarksView />
      case 'results':
        return <ResultsView />
      case 'stats':
        return <StatsView />
      case 'settings':
        return <SettingsView />
      default:
        return <ArenaView />
    }
  }

  const detailViews = ['arena', 'models', 'benchmarks', 'results', 'stats']
  const shouldShowDetailsPanel = detailViews.includes(activeView) && (selectedModelId !== null || selectedBenchmarkId !== null)

  return (
    <div className="h-screen w-screen overflow-hidden text-slate-200" style={{ backgroundColor: 'var(--app-bg)', color: 'var(--text-main)' }}>
      <AppLayout topBar={{ title: undefined }}>
        <div className="flex h-full min-h-0 w-full min-w-0 gap-[clamp(0.5rem,1vw,1rem)]">
          <div className="min-w-0 flex-1 overflow-auto">
            {isReady ? (
              <>
                {/*
                  Runner trzyma stan aktualnego benchmarku lokalnie (stream, fokus zadania,
                  wybory modeli/benchmarków). Nie odmontowujemy go przy zmianie zakładki,
                  żeby po powrocie do „Uruchom” kontynuacja była widoczna zamiast pustego ekranu.
                */}
                <div className={activeView === 'runner' ? 'block' : 'hidden'}>
                  <RunnerView />
                </div>
                {activeView !== 'runner' && renderView()}
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                {t('common.loadingData')}
              </div>
            )}
          </div>

          {shouldShowDetailsPanel && <DetailsPanel />}
        </div>
      </AppLayout>
    </div>
  )
}

export default App
