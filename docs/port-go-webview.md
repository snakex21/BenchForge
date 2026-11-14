# BenchForge: Electron → Go + WebView2 port

Branch `port/go-webview` (based on `experiment/go-migration-reviewed`, which itself is `main` v1.0.1 plus the reviewed Go experiments). The Electron app is still in the tree and unchanged; the new host lives in `go-desktop/`.

## Architecture

```
React UI (frontend/, unchanged source)  ──vite build --mode go──▶ go-desktop/internal/webui/dist (go:embed)
        │ window.benchforge / window.db  (same API as electron/preload.cjs)
        ▼
internal/bridge/shim.js  ── webview binding __bf_invoke(token, id, channel, argsJSON) ──▶ bridge.Dispatcher
        ▲ window.__bfEmit(event, data)   (task:chunk, benchmark:done, …)                 │ validated handlers
        │                                                                                ▼
WebView2 window (webview_go, patched)          cmd/benchforge/app.go  →  internal/{db,runner,sandbox,providers,updater,…}
static files from http://127.0.0.1:47821 (GET only, Host/Origin/Sec-Fetch/token checks, strict CSP)
```

* The UI is not modified. Only `frontend/vite.config.ts` gained a `go` build mode (output dir) and `package.json` a `build:go` script.
* No API runs over HTTP. The localhost server serves static files only; all calls go through the webview binding. Each call carries a per-session 256-bit token, which the init script exposes only on our origin. Every handler validates its arguments: ids must be positive integers, objects must be objects, URLs are restricted to http(s) or https, extensions are allow-listed, and the size limit is 64 MB.
* No remote content: the init script blanks any non-app http(s) document, intercepts link clicks and `window.open`, and opens external links in the system browser (HTTPS only, checked again in Go). The CSP blocks remote scripts, styles, images, fonts, frames and connections.
* The UI's `localStorage` (theme, language, layout) is mirrored to `data/webview-localstorage.json` and restored at start. The origin's port can change, so the browser's own storage alone would not persist reliably.
* The WebView2 profile lives in `data/webview2` (portable). The app needs the WebView2 Runtime, which ships with Windows 10 and 11.

## Parity checklist

Legend: ✅ ported and tested · 🟡 ported but not fully verified, or with a deliberate behaviour change · ❌ not ported

### Main-process API (72 IPC channels + 9 events from `electron/preload.cjs`)

`cmd/benchforge/app_test.go: TestAllPreloadChannelsRegistered` checks all 72 request channels and 9 events against `docs/migration/preload-contract-inventory.json`.

| Area | Channels | Status | Notes |
|---|---|---|---|
| App meta / data path | `app:get-meta`, `app:get-data-path`, `app:open-data-path` | ✅ | `platform` is always `win32` |
| External links | `app:open-external` | ✅ | HTTPS only, no credentials in URL (tested) |
| Updates | `updates:check`, `updates:download`, `updates:apply-portable` | ✅ | **fixed repo + mandatory SHA256**, see below. The swap script was run end to end on the 2.0.0 release zip (old files replaced, `data/` kept, new exe started) |
| Pricing | `pricing:status`, `pricing:refresh-openrouter` (+ auto refresh at start) | ✅ | verified live (OpenRouter) |
| Files | `files:save-json`, `files:save-text`, `files:open-json`, `files:open-path`, `files:export-artifact-zip` | ✅ 🟡 | native Win32 dialogs. The ZIP uses Deflate (Electron used Store). `open-path` is limited to `data/artifacts` |
| Benchmark library | `benchmark-library:list`, `benchmark-library:download` | ✅ | 47 packs. Golden tests compare against the outputs of the original JS (worker port) |
| Benchmark radar | `benchmark-radar:scan`, `benchmark-radar:discover` | ✅ | GitHub hosts only, HTTPS only, SHA-256 of referenced files, cache |
| Tools | `tools:list`, `tools:run` | ✅ 🟡 | Docker by default (see below). The renderer cannot choose the interpreter or image |
| Environment / health | `env:check`, `health:check` | ✅ | Node is optional (Electron probed itself). The health check reports DPAPI and the sandbox mode |
| MCP | `mcp:servers:get/save`, `mcp:tools:list`, `mcp:tool:call` | 🟡 | stdio JSON-RPC client ported. No real MCP server was tested |
| Models | `db:models:get/add/update/delete`, `db:discovered-models:get`, `models:scan`, `model:test-connection`, `model:send-prompt` | ✅ | scan and test were clicked through against a mock OpenAI server |
| Provider configs | `db:provider-configs:get-all/get/save/delete` | ✅ | |
| Benchmarks / tasks | `db:benchmarks:*`, `db:tasks:get/add/update/delete/reorder` | ✅ | |
| Results / runs / sessions | `db:results:get/add/delete/clear/rebuild-artifacts`, `db:runs:*`, `run-session:*` | ✅ | artifacts written in the same layout |
| Export / import / reset | `db:export-all`, `db:import-all`, `db:clear-all` | ✅ | import is validated before any data is deleted (Electron wiped first) |
| Preferences | `db:preference:get/set` | ✅ | `github_token` encrypted. `sandbox_host_optin` can only be set through the dialog |
| Runs | `benchmark:run`, `benchmark:run-streaming`, `benchmark:abort` | ✅ | streaming, `<think>`/`reasoning_content`, retries, attempt penalty, aggregation, resume, cancel |
| Manual | `benchmark:submit-manual`, `…-streaming`, `…-batch` | ✅ | |
| Judge | `judge:evaluate` | 🟡 | ported 1:1, not run against a real judge model |
| Events | `task:chunk`, `task:thinking-chunk`, `task:done`, `task:error`, `task:retry`, `task:tool-call`, `task:needs-maze-verify`, `benchmark:done`, `benchmark:aborted` | ✅ | `onStreamEvent` / `removeStreamListeners` / `onAborted` keep their semantics |

### Data (SQLite)

| Item | Status | Notes |
|---|---|---|
| Driver | ✅ | `modernc.org/sqlite` (pure Go, no CGO), single connection, WAL, `foreign_keys=ON` |
| Schema + additive migrations | ✅ | 1:1 port of `ensure*Schema` / `initDb`, including legacy `models` rebuild, benchmark backfill from first task, removal of auto-generated "Zadanie 1" tasks |
| Opens an existing Electron DB | ✅ | `TestOpensElectronDatabaseCopy` passed on a copy of the real `data/benchforge.db` (4 models, 2 benchmarks, 513 tasks); UI screenshots 27–29 |
| Electron opens a Go-written DB | ✅ | Electron v1.0.1 build opened the DB created/filled by the Go build (screenshot 30) |
| Migration test (old schema → new) | ✅ | `TestMigratesLegacyDatabase` (legacy models/benchmarks/tasks/results, plaintext key) |
| Latent Electron migration bug | ✅ fixed | rebuilding a legacy `models` table rewrote FKs to `models_legacy` (SQLite ≥ 3.26) and then broke deletes. Fixed with `legacy_alter_table=ON` |
| Secrets | ✅ 🟡 | new values: Windows DPAPI (`bfdpapi:v1:`). Electron `safeStorage` values (`bfsec:v1:`, Chromium v10 AES-GCM) are **read** using the key from the Electron profile's `Local State` (both profiles tried; tested with a synthetic profile and with the real DB, where 2/2 keys decrypted). `bfsec:` values are not rewritten, so the Electron build keeps working. Keys **saved by the Go build are not readable by Electron** (one-way) |
| Artifacts | ✅ | same `data/artifacts/runs/session-*/benchmark-*/result-*` layout and files |

### Model / code execution (security change)

| Item | Status | Notes |
|---|---|---|
| Docker sandbox | ✅ default | `docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 512m --cpus 1 --read-only --tmpfs /tmp --user 65534:65534`. On timeout the container is removed (`docker rm -f`) |
| Host execution | ✅ opt-in only | Turning the Docker toggle off opens a native warning dialog (default: No). Only "Yes" sets `sandbox_host_optin`. An Electron-era `sandbox_use_docker=false` is **not** treated as consent: code execution is refused until the user confirms |
| No Docker | ✅ | refuses with a message and never falls back to the host (screenshot 23) |
| Model-controlled interpreter | ✅ fixed | Electron accepted `useDocker`/`pythonPath`/`nodePath`/`pythonImage` from tool-call input. These keys are now stripped (from the model and the renderer) |
| Repo sandbox (SWE-bench patch + test command) | ✅ 🟡 | 2.0: the test command runs in Docker by default (`--network none`, caps dropped, no-new-privileges, 2 GB / 2 CPU / 512 pids, only the patched copy mounted at `/work/repo`). Image per repo: `dockerImage` in the repo sandbox JSON (default `python:3.12-alpine` / `node:22-alpine`, which have no project deps). Host execution still needs the opt-in. Tested with a real git repo and a mocked `docker` (hardened flags, mount, pass/fail scoring, timeout → `docker rm -f`, invalid image, Docker missing → nothing runs). **Not run against a real Docker daemon** (no Docker on the build machine). Also fixed: the extracted patch lost its last newline, so `git apply` failed with "corrupt patch" (Electron had the same bug) |
| Node runner on host | 🟡 | uses `node` from PATH (Electron used its own binary with `ELECTRON_RUN_AS_NODE`) |
| Tool agent | ✅ | same protocol; tools run through the sandbox runtime |
| Process tree kill | ✅ | `taskkill /T /F` on timeout |

### Updater

| Item | Status |
|---|---|
| Repository fixed in code (`snakex21/BenchForge`); `repo` from the UI is rejected unless it equals it | ✅ (tests) |
| `SHA256SUMS.txt` mandatory; missing file, missing entry or mismatch → nothing written (temp file + rename) | ✅ (tests: `TestDownloadFailsOnChecksumMismatch`, `…WithoutChecksums`, `…AssetMissingFromChecksums`) |
| Only GitHub HTTPS hosts, also for redirects; size limit | ✅ (tests) |
| Real download of v1.0.1 zip (121.8 MB) verified against the release's SHA256SUMS | ✅ (screenshot 26, hash `720b8816…03cd`) |
| Portable self-update (PowerShell swap, keeps `data/`) | ✅ executed on a copy with the 2.0.0 zip |
| Release asset names for the Go build | ✅ `BenchForge-<ver>-x64.zip`, `BenchForge-<ver>-x64.exe`, `SHA256SUMS.txt` (`go-desktop/release.ps1`, `windows-release.yml`: tags ≥ v2.0.0 only, never overwrites assets) |

### UI, i18n, settings

| Item | Status |
|---|---|
| Same React UI, all views (Arena, Runner, Models, Benchmarks, Results, Stats, Compare, Settings) | ✅ (clicked through; screenshots 01–30) |
| 58 locale catalogs / RTL | 🟡 bundled unchanged (lazy chunks served by the embedded server). Only Polish was checked visually |
| Keyboard shortcuts, themes | 🟡 bundled unchanged, not exercised |
| Window icon / exe resources | ✅ title bar, taskbar, exe icon and version info (`winres/versioninfo.json` → `rsrc_windows_amd64.syso`, `go generate`) |
| Version label in the sidebar and Settings | ✅ read from `app:get-meta` (1.x had `v1.0.0` hard-coded) |
| `frontend` tests (55 original + 8 readonly) | ✅ 63/63 still pass (`vitest run`) |

## Providers: OpenAI reasoning models (2.0)

Electron 1.x always sent `max_tokens`, which OpenAI reasoning models reject (`Unsupported parameter: 'max_tokens' ... Use 'max_completion_tokens'`, checked live with `gpt-6-luna`). 2.0 sends `max_completion_tokens` (8192, which includes the reasoning tokens) and `stream_options.include_usage` to `api.openai.com`. Any other server that rejects `max_tokens` with that message is retried once with `max_completion_tokens`. An optional `#effort=<none|minimal|low|medium|high|xhigh>` suffix on the model id (for example `gpt-6-luna#effort=low`) sends `reasoning_effort`. Pricing lookup ignores the suffix.

## Live tests (2026-11-14)

`internal/runner/live_test.go` (`TestLiveProvider`) runs only when `BF_LIVE_BASE_URL` and `BF_LIVE_MODEL` are set. It drives the real runner, DB and provider: test connection, a 3-task streaming benchmark and one non-streaming prompt.

| Provider / model | Result | Tokens (in/out) | Cost |
|---|---|---|---|
| OpenAI `gpt-6-luna#effort=low` | 3/3, streamed, usage reported | 57 / 31 (+ about 25 for the extra prompt) | about $0.00003 |
| LM Studio `lfm3-1.7b` (local) | 3/3, 220 thinking chunks split from the answer | not reported by LM Studio without `stream_options` | $0 |

## Data migration from 1.x

* Portable/zip installs: same `data/` folder, nothing to do (the 1.x updater can also install the 2.0 zip, because the asset names, the checksum format and the swap script are the same).
* NSIS installs keep data in the install folder. When the Go build starts with an empty data folder, it looks for `%LOCALAPPDATA%\Programs\benchforge-desktop\data`, `…\Programs\BenchForge\data`, `%ProgramFiles%\BenchForge\data` and the pre-0.2 `%APPDATA%\benchforge-desktop`, and offers to copy `benchforge.db` (+ WAL/SHM) and `artifacts/` (`internal/migrate`). `-import-electron <dir>` does the same without asking, and `BENCHFORGE_NO_IMPORT=1` turns the question off. The source is never written. This was tested on this machine with a real pre-0.2 database: 1,307 files were copied, and the arena showed 4 models and 2 benchmarks.

## Tests

* Go: `go test ./...`, 84 top-level tests (83 pass, 1 skipped) and 150 including subtests. The skipped one is env-gated (the real Electron DB copy); it passed when run manually. Packages: bridge, cmd (all channels registered, validation, Docker toggle, core flow via the bridge), db (migration, CRUD, import/export, Electron copy), secrets (DPAPI, Electron v10 compat, tamper), sandbox (Docker default, refusal, no host fallback, model cannot pick the interpreter, path confinement), runner (scoring goldens ported from `runner.cjs`, streaming E2E with a fake provider, cancel, Docker-only sandbox evaluation, repo sandbox refusal), providers (SSE, `<think>`, usage, errors, cancel), updater (checksum mismatch, missing sums, fixed repo, foreign hosts), webui (Host/Origin/Sec-Fetch/token/method), library and radar (golden parity with the JS), winapi.
* `go test -race` is clean for bridge, runner, sandbox and db. `go vet` is clean. `govulncheck` (v1.9.0, Go 1.26.11): no vulnerabilities.
* The 55 original tests are all frontend tests (components, store, scoring utilities). The UI is unchanged, so they stay as they are and still pass. The backend logic they never covered (runner scoring, sandbox, migrations, updater, secrets) now has Go tests.
* CI: `.github/workflows/go-desktop-ci.yml` (windows-latest) runs `npm ci`, vitest and `build:go`, then gofmt, `go vet`, `go test -race`, govulncheck and the stripped build, and uploads the artifact.

## Measurements (same machine, same seeded DB, 3 runs each; Electron = v1.0.1 `win-unpacked`)

| | Electron 35 | Go + WebView2 |
|---|---|---|
| Distributable | 300 MB folder (zip 116 MB, installer 85 MB) | **16.5 MB** single exe (6.7 MB zipped) + system WebView2 Runtime |
| Time to window | 650–770 ms | 80–280 ms |
| Time to rendered UI (sidebar painted) | **650–820 ms** | 910–1380 ms |
| RAM after 10 s idle (process tree, working set / private) | 353–357 MB / 274–287 MB (4 processes) | 366–369 MB / 276–283 MB (7 processes) |

Both render with Chromium, so memory is about the same. The size gain is large. Cold start to a rendered UI is slower in Go: `webview.New` (creating the WebView2 environment and controller) takes 450–940 ms. Ideas for later: create WebView2 asynchronously or prewarm it, and show a native splash.

## What's left (precise)

1. Repo sandbox and code sandbox against a **real Docker daemon** (only mocked so far, because the build machine has no Docker). This also covers the default images: stock `python:3.12-alpine` has no pytest, so real repos need `dockerImage`.
2. MCP: test against a real server (e.g. `@modelcontextprotocol/server-filesystem`), including timeouts and process cleanup.
3. Judge evaluation and maze verification (`task:needs-maze-verify` UI flow) against real models.
4. Locale/RTL and keyboard-shortcut smoke tests in the WebView2 host. UI Automation works on the WebView2 content (the screenshots for 2.0 were taken that way), so this can be scripted.
5. Startup: make WebView2 creation asynchronous or prewarm it (see the measurements).
6. Remove `electron/`, `electron-builder` and the root `package.json` dependencies in a later release.
7. Click through the update from a real 1.x install. The swap script and the asset names were tested, but the 1.x UI flow was not.
8. Stream usage for local servers (LM Studio supports `stream_options`), so local runs also record token counts.
9. The legacy boolean/numeric scoring quirks (e.g. any "tak" in a response passes) are preserved on purpose, as `docs/migration/go-migration-plan.md` explains. Fixing them needs a versioned evaluator.
10. Code signing of the exe.
