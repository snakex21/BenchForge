# BenchForge Go + plain-web vertical slice

**Experimental and additive. This is not a full BenchForge replacement.** The existing Electron/React/TypeScript app, benchmarks and SQLite database are unchanged. This prototype uses a separate data directory and a new, explicit `benchforge-text-v1` evaluator contract. Its scores must not be merged with or directly ranked against legacy boolean/numeric/self-scored/rubric results.

## Run

Go 1.23+ and a browser are sufficient; no npm, Electron, Python or CGO dependencies are needed for this slice.

```
cd go-prototype
go test -race ./...
go vet ./...
go run .
```

Open `http://127.0.0.1:8787` in your browser. The default offline echo provider returns prompts literally: it tests the runner and result handling, **not AI quality**. The example has an intentional failed case (14 must not equal 4).

To run a local model already available in LM Studio or another OpenAI-compatible server:

```
go run . -endpoint http://127.0.0.1:1234/v1 -models your-model-id
```

Multiple model IDs can be comma-separated. Prompts are sent only to that configured loopback server. Check that the server exposes the requested models. Local server authentication, cloud API keys and cloud endpoints are deliberately outside this first slice. No model is downloaded or started automatically.

For compiled bundles, run `benchforge-go.exe` on Windows or `./benchforge-go` on Linux; flags are the same. Keep the executable in a writable folder. Reports default to `benchforge-go-data/` relative to the current working directory; set `-data-dir` explicitly if needed. Never point it at the legacy BenchForge database directory. The UI does not open automatically.

## Implemented and verified

- Embedded HTML/CSS/plain JavaScript, no framework/build pipeline
- Explicit exact and contains text checks; empty responses fail; no self-scoring
- Sequential task/model matrix with rotated model order; uniform max tokens, temperature and per-request deadline; actual order retained; no silent retries
- Context cancellation of local HTTP requests; partial results preserved; interrupted jobs detected on restart
- Null comparable score until every planned task for that model has a valid pass/fail outcome; provider errors/timeouts/cancellation are not silently dropped from the denominator
- Suite SHA-256, evaluator contract, requested and returned model IDs, normalized provider endpoint, optional server fingerprint, settings, outputs, reported token counts and durations in each JSON report
- Single active run; atomic JSON persistence; current/recent results plus JSON export; older reports retained on disk
- Loopback-only listener and provider endpoints, Host/Origin checks, JSON-only mutations, CSP, redirect rejection in the production API client, bounded request/model/report sizes

Run tests: `go test -race -count=1 ./...`, `go vet ./...`, `go build .`, and `node --check web/app.js` (Node is needed only for that optional syntax check).

## Deliberate compatibility boundary

Legacy benchmark JSON is rejected rather than silently reinterpreted. Explicitly convert a task to `id`, `prompt`, `mode`, `expected` under the new version, review it, and establish a fresh baseline. See `examples/offline.json` for the full POST body; paste it into the UI or POST with `Content-Type: application/json` to `/api/runs`.

Not yet ported: SQLite import/migration; API secrets; streaming and reasoning traces; existing boolean/numeric scoring; manual, rubric, maze/image and code-presence modes; executable Python/Node/TypeScript/repo sandboxes; tool agents and MCP; benchmark library/radar imports; billing/pricing; arena, charts, CSV/ZIP/database backups; portable updater/installers; the existing 58 locale catalogs. All remain in the existing app. A normal HTTP handler must never be presented as a code sandbox.

Go test doubles and an actual local httptest HTTP server validate the provider contract; no real LLM inference or remote paid API was tested. Cloud-browser inspection of localhost was blocked by `ERR_BLOCKED_BY_CLIENT`, so rendered appearance, responsive layout and browser interactions are not claimed tested. API integration, embedded-asset serving and JavaScript syntax were tested. Windows cross-compilation is not a Windows runtime test.

## Security and fairness limits

This is a local single-user prototype, not an internet-facing server. Do not reverse-proxy or expose its port. Reports contain prompts and model output; keep the folder private. It has no process-execution endpoint. Sequential rotation reduces fixed first-model ordering, but does not control GPU warmup, caches, stochasticity, quantization, server-side defaults or thermal load. Use repeated, counterbalanced runs and record model/runtime/hardware provenance before claiming model superiority or throughput improvements. No existing benchmark score is retroactively changed.
