# BenchForge read-only Go viewer: one frontend-parity slice

This separate experimental executable preserves the existing React `StatsView`, CSS, scoring-display utilities, and 58 locale catalogs as **compiled static HTML/CSS/JavaScript served by Go**. It does not require Node or Electron at runtime. It is not the complete BenchForge application and does not replace the reviewed `go-prototype` benchmark runner.

## Run

```
go test -race ./...
go vet ./...
go run .
```

Open `http://127.0.0.1:8788`. Default data is an embedded synthetic fixture, clearly labeled; no model/API is contacted. The viewer shows existing statistics plus a minimal inventory of preserved models/benchmarks/tasks. The wrapper's capability notices are English; the existing statistics labels retain the original 58-language/RTL system.

A separately prepared copied JSON snapshot with the explicit `benchforge-readonly-snapshot-v1` envelope can be selected with `-snapshot path/to/copied-snapshot.json`. See `examples/synthetic.json`. This is an export snapshot contract, **not** support for opening, converting, migrating or writing a SQLite database. Do not pass your live database. No live user data has been tested.

Six actual GET routes: metadata, models, benchmarks, tasks for one benchmark, results, runs. Unsupported routes return errors. Every non-GET/HEAD request is rejected, including POST, PUT, PATCH, DELETE and OPTIONS. There are no write, cleanup, model-call, tool, MCP, import or updater endpoints. Reads use an immutable in-memory projection loaded once at startup. Restart to load a changed snapshot.

The model projection excludes API keys and endpoint credentials. The statistics projection excludes thinking notes and artifact paths. Ordinary response notes are retained because existing code-presence display logic uses them; they may contain private output. Missing/null collections and malformed projected field types are rejected before serving a success snapshot. The input file remains unchanged; this is not a lossy writeback/export. Keep snapshot data private nonetheless. A shared localhost browser origin is not a substitute for an internet-facing security design; never expose this server.

## Build the actual reused frontend

The generated web assets are included so a Go-only source build is runnable. To rebuild after changing frontend sources, install the root and frontend npm dependency sets, then:

```
cd ../frontend
npm test
npx tsc -b
npx vite build --mode readonly
cd ../go-viewer
go test -race ./...
go build .
```

The normal Vite mode still builds the existing Electron frontend. Read-only mode selects `frontend/readonly.html` and `frontend/src/readonly/main.tsx`; it never mounts the old full App/Runner/Settings. Its bounded typed transport declares the supported functions instead of pretending all 72 IPC routes exist.

`benchmarkStore.loadFromDb({readOnly:true, source:...})` explicitly gates the historical stale-task deletion. The test fixture intentionally contains a legacy `Zadanie 1` task: opening preserves it. Default Electron callers retain their original cleanup behavior; both modes are regression-tested.

## Verification scope

- Twelve Go server tests pass with race detector; go vet passes
- 63 frontend unit/DOM tests pass, including the original 55 tests
- Real `StatsView` rendering in jsdom verifies fixture data, inventory, 58 language options, RTL switching and visible API failure; this is not browser visual QA
- Binary HTTP smoke proves real reads, all tested writes rejected, the source content/mtime unchanged, and no new data files
- Read-only Vite build and default frontend build pass
- Loopback Host/Origin checks; no outbound HTTP/model client in this server
- No real model inference, browser visual/interaction QA, live database migration, native Windows execution or full-app parity claim

The browser limitation from the previous slice still applies: the cloud browser blocks localhost navigation. Windows binaries may be cross-built, but require native Windows testing before release.
