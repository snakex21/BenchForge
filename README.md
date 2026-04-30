# BenchForge

AI model benchmarking desktop app with custom benchmarks, sandboxed code evaluation, tool/MCP agent tests, result analytics, and artifact exports.

---

## Languages / Języki / Sprachen / Idiomas

- [English](#english)
- [Polski](#polski)
- [Deutsch](#deutsch)
- [Español](#español)

---

## English

### What is BenchForge?

BenchForge is a desktop application for comparing AI models on custom and imported benchmarks. It is designed for local experimentation, model comparison, code evaluation, agent/tool benchmarks, and result analysis.

### Main features

- **Model management**
  - Local models: LM Studio, Ollama.
  - API providers: OpenAI-compatible endpoints and many provider presets.
  - Manual mode for copy-paste testing.

- **Benchmark management**
  - Create and edit benchmarks and tasks.
  - Import/export benchmark JSON.
  - Benchmark Library with many ready-made packs, including HumanEval, MBPP, GSM8K, SWE-bench Lite, MMLU mini, ARC mini, TruthfulQA mini, MCP benchmarks, and more.

- **Evaluation modes**
  - Exact/simple answers, e.g. `2 + 2 = 4`.
  - `code_presence` checks.
  - Python/Node sandbox test execution.
  - TypeScript-lite support for simple functions.
  - Manual grading with point rubrics.
  - Tool-agent and MCP benchmarks.
  - Repo/patch sandbox for SWE-bench-style tasks.

- **Sandbox and tools**
  - `python.run`, `node.run`, file tools, image path SVG tool.
  - Optional Docker mode for Python/Node sandboxing.
  - Tool trace artifacts.
  - MCP stdio client support: list tools and call tools from configured MCP servers.

- **Results and analytics**
  - Arena matrix, ranking, bar charts, radar, trends.
  - Results history grouped by model or benchmark.
  - Sandbox reports, agent reports, tool traces, and artifacts.
  - CSV/JSON export.
  - ZIP export for result artifacts.
  - Backup/import of the full database.

- **International UI**
  - Polish, English, German, Spanish.

### Tech stack

- Electron
- React
- TypeScript
- Vite
- Zustand
- SQLite / better-sqlite3
- Tailwind CSS

### Getting started

Windows quick start:

```bash
start-electron.bat
```

Manual start:

```bash
npm install
npm run install:frontend
npm start
```

Build installer:

```bash
npm run dist
```

Windows release artifacts are created in `release/`:

- NSIS installer: `BenchForge-Setup-<version>-x64.exe`
- Portable build: `BenchForge-Portable-<version>-x64.exe`
- ZIP archive: `BenchForge-<version>-x64.zip`
- Checksums: `SHA256SUMS.txt`

You can also run:

```bash
npm run release:win
```

GitHub Actions workflow `Windows Release Build` builds the same artifacts on `workflow_dispatch` and on tags like `v1.0.0`. Tag builds create a draft GitHub Release.

### Data and security notes

- App data is stored in the portable-first `data/` folder next to the app/project, e.g. `BenchForge/data/benchforge.db`.
- Local exports, backups, artifacts, SQLite files, build outputs, and `node_modules` should not be committed.
- API keys and GitHub Radar tokens are encrypted locally with Electron `safeStorage` when available. Database backups/exports omit API keys.
- MCP servers and sandboxed code can interact with your system depending on your configuration. Only enable tools and directories you trust.
- Docker sandboxing is optional and requires Docker to be installed.

### License

MIT

---

## Polski

### Czym jest BenchForge?

BenchForge to desktopowa aplikacja do porównywania modeli AI na własnych i importowanych benchmarkach. Program służy do testowania modeli, oceny kodu, porównywania odpowiedzi, benchmarków agentowych/toolowych oraz analizy wyników.

### Najważniejsze funkcje

- **Zarządzanie modelami**
  - Modele lokalne: LM Studio, Ollama.
  - Providery API: endpointy OpenAI-compatible i wiele presetów providerów.
  - Tryb manualny do testów copy-paste.

- **Zarządzanie benchmarkami**
  - Tworzenie i edycja benchmarków oraz zadań.
  - Import/eksport benchmarków jako JSON.
  - Biblioteka benchmarków: HumanEval, MBPP, GSM8K, SWE-bench Lite, MMLU mini, ARC mini, TruthfulQA mini, benchmarki MCP i inne.

- **Tryby oceny**
  - Proste odpowiedzi, np. `2 + 2 = 4`.
  - Warunki `code_presence`.
  - Uruchamianie testów Python/Node w sandboxie.
  - Prosty TypeScript-lite dla funkcji.
  - Ręczna ocena punktową rubryką.
  - Benchmarki tool-agent i MCP.
  - Repo/patch sandbox dla zadań typu SWE-bench.

- **Sandbox i narzędzia**
  - `python.run`, `node.run`, narzędzia plików, generowanie SVG ścieżki.
  - Opcjonalny Docker dla sandboxa Python/Node.
  - Artefakty i trace wywołań narzędzi.
  - Obsługa MCP przez stdio: listowanie i wywoływanie toolsów MCP.

- **Wyniki i analityka**
  - Arena, macierz, ranking, słupki, radar, trendy.
  - Historia wyników według modeli lub benchmarków.
  - Raporty sandboxa, raporty agentowe, tool trace i artefakty.
  - Eksport CSV/JSON.
  - Eksport artefaktów wyniku do ZIP.
  - Backup/import całej bazy.

- **Języki interfejsu**
  - Polski, angielski, niemiecki, hiszpański.

### Stack technologiczny

- Electron
- React
- TypeScript
- Vite
- Zustand
- SQLite / better-sqlite3
- Tailwind CSS

### Uruchamianie

Najprościej na Windows:

```bash
start-electron.bat
```

Ręcznie:

```bash
npm install
npm run install:frontend
npm start
```

Build instalatora:

```bash
npm run dist
```

Artefakty Windows pojawią się w katalogu `release/`:

- instalator NSIS: `BenchForge-Setup-<version>-x64.exe`
- wersja portable: `BenchForge-Portable-<version>-x64.exe`
- archiwum ZIP: `BenchForge-<version>-x64.zip`
- sumy kontrolne: `SHA256SUMS.txt`

Możesz też uruchomić:

```bash
npm run release:win
```

Workflow GitHub Actions `Windows Release Build` buduje te same artefakty ręcznie (`workflow_dispatch`) oraz dla tagów typu `v1.0.0`. Build z taga tworzy draft GitHub Release.

### Dane i bezpieczeństwo

- Dane aplikacji są przechowywane portable-first w folderze `data/` obok aplikacji/projektu, np. `BenchForge/data/benchforge.db`.
- Lokalne eksporty, backupy, artefakty, pliki SQLite, buildy i `node_modules` nie powinny być commitowane.
- Klucze API i token GitHub Radaru są lokalnie szyfrowane przez Electron `safeStorage`, jeśli jest dostępny. Backup/eksport bazy pomija klucze API.
- MCP i sandbox mogą mieć dostęp do systemu zależnie od konfiguracji. Włączaj tylko zaufane katalogi i narzędzia.
- Docker sandbox jest opcjonalny i wymaga zainstalowanego Dockera.

### Licencja

MIT

---

## Deutsch

### Was ist BenchForge?

BenchForge ist eine Desktop-Anwendung zum Vergleichen von KI-Modellen mit eigenen und importierten Benchmarks. Sie eignet sich für lokale Experimente, Code-Auswertung, Tool-/Agent-Benchmarks und Ergebnisanalyse.

### Hauptfunktionen

- **Modellverwaltung**
  - Lokale Modelle: LM Studio, Ollama.
  - API-Provider: OpenAI-kompatible Endpunkte und viele Presets.
  - Manueller Copy-Paste-Modus.

- **Benchmark-Verwaltung**
  - Benchmarks und Aufgaben erstellen und bearbeiten.
  - JSON-Import/-Export.
  - Benchmark-Bibliothek mit HumanEval, MBPP, GSM8K, SWE-bench Lite, MMLU mini, ARC mini, TruthfulQA mini, MCP-Benchmarks und mehr.

- **Bewertungsmodi**
  - Einfache Antworten, z. B. `2 + 2 = 4`.
  - `code_presence`-Prüfungen.
  - Python/Node-Tests im Sandbox-Modus.
  - TypeScript-lite für einfache Funktionen.
  - Manuelle Bewertung mit Punkt-Rubrik.
  - Tool-Agent- und MCP-Benchmarks.
  - Repo/Patch-Sandbox für SWE-bench-ähnliche Aufgaben.

- **Sandbox und Tools**
  - `python.run`, `node.run`, Datei-Tools, SVG-Pfad-Tool.
  - Optionaler Docker-Modus für Python/Node.
  - Artefakte und Tool-Traces.
  - MCP über stdio: Tools auflisten und aufrufen.

- **Ergebnisse und Analyse**
  - Arena-Matrix, Ranking, Balkendiagramme, Radar, Trends.
  - Ergebnisverlauf nach Modell oder Benchmark.
  - Sandbox-Reports, Agent-Reports, Tool-Traces und Artefakte.
  - CSV/JSON-Export.
  - ZIP-Export für Ergebnis-Artefakte.
  - Backup/Import der gesamten Datenbank.

- **UI-Sprachen**
  - Polnisch, Englisch, Deutsch, Spanisch.

### Tech stack

- Electron
- React
- TypeScript
- Vite
- Zustand
- SQLite / better-sqlite3
- Tailwind CSS

### Start

Windows quick start:

```bash
start-electron.bat
```

Manuell:

```bash
npm install
npm run install:frontend
npm start
```

Installer bauen:

```bash
npm run dist
```

Windows-Artefakte werden im Ordner `release/` erstellt:

- NSIS-Installer: `BenchForge-Setup-<version>-x64.exe`
- Portable Build: `BenchForge-Portable-<version>-x64.exe`
- ZIP-Archiv: `BenchForge-<version>-x64.zip`
- Prüfsummen: `SHA256SUMS.txt`

Alternativ:

```bash
npm run release:win
```

Der GitHub-Actions-Workflow `Windows Release Build` baut dieselben Artefakte per `workflow_dispatch` und für Tags wie `v1.0.0`. Tag-Builds erstellen einen Draft GitHub Release.

### Daten und Sicherheit

- App-Daten liegen portable-first im Ordner `data/` neben der App/dem Projekt, z. B. `BenchForge/data/benchforge.db`.
- Lokale Exporte, Backups, Artefakte, SQLite-Dateien, Builds und `node_modules` sollten nicht committed werden.
- API-Keys und GitHub-Radar-Tokens werden lokal mit Electron `safeStorage` verschlüsselt, wenn verfügbar. Backups/Exporte enthalten keine API-Keys.
- MCP-Server und Sandbox-Code können je nach Konfiguration auf das System zugreifen. Nur vertrauenswürdige Tools und Verzeichnisse aktivieren.
- Docker-Sandboxing ist optional und erfordert Docker.

### Lizenz

MIT

---

## Español

### ¿Qué es BenchForge?

BenchForge es una aplicación de escritorio para comparar modelos de IA con benchmarks personalizados e importados. Está pensada para experimentos locales, evaluación de código, benchmarks con herramientas/agentes y análisis de resultados.

### Funciones principales

- **Gestión de modelos**
  - Modelos locales: LM Studio, Ollama.
  - Proveedores API: endpoints compatibles con OpenAI y muchos presets.
  - Modo manual para pruebas copy-paste.

- **Gestión de benchmarks**
  - Crear y editar benchmarks y tareas.
  - Importar/exportar JSON.
  - Biblioteca de benchmarks: HumanEval, MBPP, GSM8K, SWE-bench Lite, MMLU mini, ARC mini, TruthfulQA mini, benchmarks MCP y más.

- **Modos de evaluación**
  - Respuestas simples, por ejemplo `2 + 2 = 4`.
  - Comprobaciones `code_presence`.
  - Ejecución de tests Python/Node en sandbox.
  - TypeScript-lite para funciones simples.
  - Evaluación manual con rúbrica de puntos.
  - Benchmarks tool-agent y MCP.
  - Repo/patch sandbox para tareas tipo SWE-bench.

- **Sandbox y herramientas**
  - `python.run`, `node.run`, herramientas de archivos, herramienta SVG para rutas.
  - Docker opcional para sandbox Python/Node.
  - Artefactos y trazas de herramientas.
  - Soporte MCP por stdio: listar y llamar herramientas MCP.

- **Resultados y analítica**
  - Arena, matriz, ranking, barras, radar, tendencias.
  - Historial por modelo o benchmark.
  - Informes de sandbox, informes de agente, tool traces y artefactos.
  - Exportación CSV/JSON.
  - Exportación ZIP de artefactos.
  - Backup/importación completa de la base de datos.

- **Idiomas de la interfaz**
  - Polaco, inglés, alemán, español.

### Stack tecnológico

- Electron
- React
- TypeScript
- Vite
- Zustand
- SQLite / better-sqlite3
- Tailwind CSS

### Inicio

Inicio rápido en Windows:

```bash
start-electron.bat
```

Manual:

```bash
npm install
npm run install:frontend
npm start
```

Crear instalador:

```bash
npm run dist
```

Los artefactos de Windows aparecerán en `release/`:

- Instalador NSIS: `BenchForge-Setup-<version>-x64.exe`
- Build portable: `BenchForge-Portable-<version>-x64.exe`
- Archivo ZIP: `BenchForge-<version>-x64.zip`
- Checksums: `SHA256SUMS.txt`

También puedes ejecutar:

```bash
npm run release:win
```

El workflow de GitHub Actions `Windows Release Build` genera los mismos artefactos con `workflow_dispatch` y para tags como `v1.0.0`. Los builds por tag crean un borrador de GitHub Release.

### Datos y seguridad

- Los datos se guardan en modo portable-first en la carpeta `data/` junto a la app/proyecto, por ejemplo `BenchForge/data/benchforge.db`.
- Exportaciones locales, backups, artefactos, archivos SQLite, builds y `node_modules` no deben subirse al repositorio.
- Las API keys y tokens de GitHub Radar se cifran localmente con Electron `safeStorage` cuando está disponible. Los backups/exportaciones omiten las API keys.
- MCP y sandbox pueden acceder al sistema según la configuración. Activa solo herramientas y directorios de confianza.
- Docker sandbox es opcional y requiere Docker instalado.

### Licencia

MIT
