# Preserve the existing frontend while moving the backend to Go

## Recommendation

Keep the existing React/TypeScript frontend **source** and build it to static HTML/CSS/JavaScript, then embed/serve that build from Go. Node/Vite/TypeScript are build tools; this route does not require shipping a Node/Electron runtime. The user's requested Go + HTML/CSS/JS architecture does not require discarding a React source tree. The plain-JavaScript text-runner prototype is a diagnostic vertical slice, not the recommended replacement for all existing screens.

Verified on baseline `5a95d358ec060bd6d48e0e7d42826d1ac3e5a799`: root+frontend npm dependency install, 55 frontend tests, TypeScript compilation and Vite production build pass. `frontend/dist` is approximately 4.3 MiB on disk. Source imports and emitted assets contain no direct Electron/Node builtin imports in the inspected frontend. The binding is through `window.db` and `window.benchforge`, declared in `frontend/src/global.d.ts` and populated by `electron/preload.cjs`. The preload exposes 72 distinct IPC request channels and 9 event channels (inventory included). This is a manageable compatibility boundary, but serving static files alone does not supply the backend methods.

## Options

| Approach | Runtime | Feature preservation | Main cost / risk | Recommendation |
|---|---|---|---|---|
| Go + existing compiled React frontend | Go executable + user's browser, or an explicitly selected WebView | Reuses existing screens, localizations, styles, charts, keyboard behavior | Replace typed IPC boundary, storage, native functions and streaming; test browser-origin differences | Preferred target |
| Go + complete plain-JavaScript UI rewrite | Go executable + browser/WebView | Every screen and interaction must be rebuilt and retested | Largest feature-loss and locale/RTL regression surface; runtime JS still exists | Only if explicitly desired after parity scope is agreed |
| Keep Electron temporarily, route backend work to Go | Electron during transition, plus Go process | Safest incremental comparison against current UI | Transitional extra process/packaging complexity; does not yet meet no-Electron runtime goal | Optional bridge while verifying parity |
| Current small Go/plain-web slice | Go executable + browser | Explicit text-runner subset only | No legacy data/UI parity | Useful testbed, not replacement |

## Compatibility matrix

| Existing capability | Reusable static frontend part | Go / browser adaptation needed | Current Go slice |
|---|---|---|---|
| Arena, compare, stats, history and detail panels | Existing React components and scoring display utilities | Read models/benchmarks/tasks/results/runs with unchanged IDs/schema; distinguish evaluator versions | Not ported |
| 58 languages and RTL | Locale JSONs, dynamic locale chunks, lang/dir logic, labels | Serve every generated asset; verify font/layout and locale persistence | English-only diagnostic page |
| Themes, keyboard shortcuts and UI state | CSS, hooks, Zustand persistence | File-origin -> HTTP-origin state migration; stable origin/port or backend-backed preferences | Basic diagnostic styling |
| Models and provider settings | Forms, scan controls, existing types | Safe provider configuration API; secret storage remains backend-only | Fixed CLI model list, loopback only |
| Benchmark/task CRUD | Existing forms/types | Versioned validation and copied-db/snapshot import; transactions and explicit write controls | New text schema only |
| Boolean/numeric/manual/rubric/maze/code-presence scores | Existing labels/controls | Golden-case evaluation contracts + provenance; preserve historical views without ranking mixed versions | Exact/contains new contract only |
| Streaming, thinking, tool traces | Runner presentation | SSE/WebSocket events carrying run IDs, unsubscribe, reconnection, cancel and partial state semantics | Snapshot polling, no streaming |
| Run sessions and resume | Existing runner state structures | Durable Go run state + cancellation/process ownership; no silent re-execution after restart | Interrupted status and preserved results, no automatic resume |
| Local code/repo sandbox, agent tools and MCP | Trace/sandbox-result views | Restricted workers, runtime discovery, resource/network limits; adapt SuperCli harness through explicit contract | Unsupported; no execution endpoint |
| JSON/CSV imports/exports | Existing parsing/display, some Blob downloads already present | Browser file picker/upload or download API; native dialogs optional only with chosen desktop wrapper | JSON report export |
| Artifacts, ZIP and database backup | Existing buttons and views | Bounded backend archive/backup routes and path confinement; explicit restore workflow | Separate JSON report files |
| Open folder/path/external URL | Existing commands | Browser cannot directly expose arbitrary local paths; download endpoints or allowlisted OS integration | Unsupported |
| Updates / portable installation | Existing settings UI labels | Go update verifier, rollback, executable locking and signing per OS | No updater or installer |
| Pricing, radar/library and judge | Existing screens/types | Port fetch/cache/credential boundaries and preserve external-call opt-in | Unsupported |
| Saved API keys | Settings presentation only | Equivalent OS-backed protection; never return raw keys to browser by default | No key support |

## Next narrow parity slice (recommended; not implemented here)

1. Add an explicitly versioned browser transport adapter implementing the existing TypeScript API shape, initialized before `createRoot`. Map approved reads to HTTP, then map events to run-scoped SSE subscriptions. Keep Electron preload as one adapter during development if useful. Do not fake successful results for unimplemented functions.
2. Embed the real Vite build with all locale chunks into a separate Go entrypoint. Start with a **read-only viewer of a copied exported snapshot**, not the user's live SQLite database. Populate real model/benchmark/task/result/run fixtures to exercise existing Arena/Results/Stats/Compare screens. Scrub any secrets from test data and responses.
3. Add capability flags and visibly disabled unsupported actions. The existing optional chains and empty-array fallbacks can otherwise make missing APIs appear like an empty database or silent no-op.
4. **Remove/gate bootstrap writes before claiming read-only.** `frontend/src/store/benchmarkStore.ts:loadFromDb` calls `db.tasks.delete` to clean legacy auto-generated tasks during initial load. Move that cleanup into an explicit versioned migration on a copied dataset, and test that viewing cannot delete anything. Do not implement the delete route as a success-returning stub.
5. Preserve old result schemas and label evaluator provenance. Do not translate historical scores into `benchforge-text-v1` or mix them into its ranking. Add round-trip/golden fixtures before the next writable storage slice.
6. Verify full asset requests, every 72-method/9-event transport declaration, unsupported-capability errors, browser reload/navigation, result rendering, locale switching and RTL, and no startup mutation. Then add one safe write slice (benchmark/task CRUD on a copy), followed by provider and streaming parity.

## Details that must not be skipped

- `vite.config.ts` already uses relative base `./`; keep asset paths consistent when embedding beneath a prefix. Do not use the Vite development server or its permissive dev CORS in the shipped app.
- Existing React components use inline styles and data/blob images. The prototype's strict CSP is not a drop-in policy for the old UI; inventory/refactor style/image usage or define a deliberate compatible policy. Do not weaken script origin restrictions casually.
- `uiStore.ts` uses localStorage under `benchforge-ui` (version 3). Electron file-origin storage will not automatically follow into a loopback HTTP origin. A different dynamic port creates a different origin; portable UI preferences need explicit handling.
- A system browser removes Chromium bundling but changes native-dialog/open-path behavior. A WebView keeps an app window but introduces platform runtime and packaging constraints. Neither option is proven on Windows here.
- Frontend parity does not port better-sqlite3, safeStorage, Electron native menus/dialogs or the executable sandbox. Those remain explicit backend/platform work.

This comparison is grounded in code inspection and a successful static build, not rendered-browser QA; the cloud browser's localhost navigation remains blocked.
