# BenchForge

Desktopowa aplikacja do porównywania modeli AI na benchmarkach.

## Aktualny stack

- Electron
- React
- TypeScript
- Vite
- Zustand
- SQLite

## Uruchamianie

Najprościej na Windows:

- uruchom `start-electron.bat`

Albo ręcznie:

1. `npm install`
2. `npm run install:frontend`
3. `npm start`

## Build instalatora

- `npm run dist`

Instalator pojawi się w katalogu `release/`.

## Uwagi

- dane aplikacji są trzymane w SQLite w katalogu `app.getPath('userData')`
- eksport i import danych używają natywnych okien systemowych Electron
