# BenchForge migration audit and bounded plan

Baseline `5a95d358ec060bd6d48e0e7d42826d1ac3e5a799`, MIT. Work branch `experiment/go-vertical-slice`. Experimental branch only; the default application is not replaced.

## Current architecture

- Electron 35 main/preload IPC bridge; React 19 + TypeScript 6 + Vite 8 frontend, Zustand state, Tailwind 4 styles
- better-sqlite3 persistence with existing migration logic and portable data paths
- runner plus provider adapters (OpenAI-compatible and manual); streaming/cancellation, retry weighting and aggregate scoring
- local code and repository evaluators, tool agent, tool runtime, MCP runtime; executable work is security-sensitive and requires isolated workers
- benchmark library/radar, pricing, artifacts/backups, secretStore safeStorage, updater and Windows packaging
- 58 locale JSON catalogs, RTL support, history/arena/statistics/chart views
- MIT permits reuse, retaining notices; bundled third-party benchmark dataset licenses need individual review, not an assumption from the application license

## Important scoring issue found by inspection

`electron/runner.cjs:evaluateBooleanResponse` returns `tak` if that word occurs before consulting the expected-answer text. Expected answer `4` can therefore be bypassed by responding `tak`; its fallback substring matching can also accept `14`. The numeric mode extracts a 0..100-looking number from model response, which can be self-scoring depending on the benchmark's intended contract. These modes cannot be treated as objective accuracy without reviewing task intent. No legacy behavior or result is modified in this branch: historical rankings must remain traceable, and a fix needs an evaluator-version column/schema, UI/export provenance, backfill policy and corpus regression tests. An in-place one-line change would silently mix incomparable results.

The new text contract deliberately separates exact matching from explicit contains matching. Existing boolean/numeric/manual/rubric functionality remains in Electron until a versioned migration is reviewed. The prototype's percentage is not a conversion of legacy scores.

## Where Go helps, and where it does not

A standard-library Go backend with embedded web assets removes this slice's Electron/Node runtime packaging dependency and provides explicit cancellation and a testable scheduler. Go does not accelerate remote model inference or GPU inference merely by changing the orchestrator. Compare cold start, package size, idle/peak RSS, task scheduling overhead, first token/last token timing and cancellation latency under identical providers/tasks before performance claims. Rendering still uses a browser; a native desktop WebView wrapper would introduce platform/runtime dependencies and requires a separate packaging decision.

## SuperCli reuse

Inspected the actual MIT SuperCli checkout, `internal/agenteval/{bench.go,suite.go}` at `3ff6f5f1f046bce6875b225d101dd91cea35d7fc`. Reusable patterns: versioned reports, context deadlines, fixture-per-run isolation, argv verification commands, expected/forbidden changes and trace assertions, offline provider injection. Direct import is not drop-in: Go `internal` boundaries and `supercli/internal/system/childproc` couple it to the parent module; its task/report schema differs from BenchForge. Extract a small MIT-attributed neutral evaluation module or use a versioned CLI JSON adapter after contract tests. Do not copy the whole agent engine or let a tool harness be both the agent under test and an unverified judge. The prototype uses these patterns but copies no SuperCli source and does not mutate that checkout.

## Stages and acceptance gates

1. **Now, additive vertical slice**: runnable Go backend + plain HTML/CSS/JS, explicit text contract, local API provider, cancellation, portable JSON evidence and regression tests. Keep Electron intact.
2. **Versioned scoring and data contract**: enumerate every current benchmark/task/result/session field, build golden fixtures for all evaluation modes, add provenance to SQLite/history/exports. Define how old runs display without entering new rankings. Back up/copy data and compare round trips before any migration writes.
3. **Provider and runner parity**: API presets/secrets/manual input, streaming/usage/reasoning traces, configurable retries, pause/resume, deadlines and model scheduling. Fix fairness, cancellation and partial-score semantics with pinned fixtures; do not silently carry old self-grading flaws forward.
4. **Trusted execution workers**: code/repo/tool/MCP coverage in dedicated restricted subprocess/container workers; port or adapt the SuperCli harness with filesystem, network, process-tree cleanup and malicious-fixture tests. Desktop filesystem access alone is not a sandbox.
5. **Frontend parity**: preserve the existing React/TypeScript source and embed its compiled static HTML/CSS/JS output in Go (Node is build-time only). Replace IPC behind the existing typed API boundary rather than rebuild every screen. See `frontend-reuse-comparison.md` for the verified 72-request/9-event seam, compatibility matrix, bootstrap-write trap and recommended read-only snapshot slice. Preserve arena, history, charts, imports, exports, backups and all 58 locale/RTL workflows. A JSON editor is a development slice, not feature parity.
6. **Portable desktop release**: compare system browser vs WebView; Windows packaging/updater, migration rollback, secret-store implementation, signed artifacts and cross-platform end-to-end tests. Publish only after approval and all gates pass.

## Verification limitations

The first slice does not prove a faster complete application or full migration. No model/runtime downloads, paid calls, executable untrusted benchmark tasks or production database writes were used. Legacy Electron integration and Windows native runtime require separate verification. See `verification.txt` for executed checks and reported baseline issues.
