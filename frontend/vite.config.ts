// ============================================================
// Vite config — skonfigurowany dla Electron
// ============================================================

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Uzyj scieszek relatywnych — Electron ładuje pliki z dysku lokalnie
  base: './',

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Wbudowane moduły Node.js (BrowserWindow itp.) muszą być
  // traktowane jako "external" — Electron zaimportuje je natywnie
  build: {
    rollupOptions: {
      external: ['electron'],
    },
    // Inline assets smaller than 100KB as base64 (icons load immediately, no HTTP requests)
    assetsInlineLimit: 102400,
  },

  server: {
    port: 5173,
    // Pozwól na ładowanie z dowolnego originu (Electron używa file://)
    cors: true,
    strictPort: true,
  },
})
