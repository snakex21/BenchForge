// ============================================================
// AppLayout — główny layout aplikacji (sidebar + content)
// ============================================================

import React from 'react'
import { Sidebar } from './Sidebar'
import { TopBar, type TopBarProps } from './TopBar'

interface AppLayoutProps {
  children: React.ReactNode
  topBar?: Partial<TopBarProps>
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children, topBar }) => {
  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ backgroundColor: 'var(--app-bg)' }}>
      {/* Sidebar */}
      <Sidebar />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {topBar && (
          <TopBar title={topBar.title || ''} actions={topBar.actions} />
        )}

        {/* Scrollable content */}
        <main className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
          <div className="h-full min-w-0 w-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
