# BenchForge desktop: Go + WebView2 host

This replaces the Electron main process. The React UI from `../frontend` is unchanged and embedded into a single `BenchForge.exe`, which is about 17 MB and needs the Microsoft Edge WebView2 Runtime (included with Windows 10 and 11).

See `../docs/port-go-webview.md` for the architecture, the parity checklist, the security changes and the measurements.

## Build

Requirements: Go (the version in `go.mod`; it is fetched automatically), MinGW-w64 `gcc` (webview_go uses CGO), and Node 22 for the UI build.

```
cd frontend && npm ci && cd ..
go-desktop\build.bat 2.0.0
```

Release files (zip, exe and `SHA256SUMS.txt` in `dist\`): `powershell -ExecutionPolicy Bypass -File go-desktop\release.ps1 -Version 2.0.0`. Exe icon and version info come from `winres/versioninfo.json`. After changing it, run `go generate ./cmd/benchforge`.

`build.bat` runs `npm run build:go`, which writes the UI to `internal/webui/dist`. It then builds with `-trimpath -ldflags "-H windowsgui -s -w"`.

## Run

`BenchForge.exe` stores everything in `data\` next to the exe: `benchforge.db`, `artifacts\`, the WebView2 profile and a log. You can override the location with `BENCHFORGE_DATA_DIR`. An existing `data\benchforge.db` from the Electron build opens as is, and stored API keys stay readable.

`-debug` turns on WebView2 devtools. `-import-electron <folder>` copies a 1.x data folder (`benchforge.db` + artifacts) into an empty data folder. Without the flag, the first start offers this when it finds a 1.x NSIS install (set `BENCHFORGE_NO_IMPORT=1` to skip the question).

## Code execution policy

Model-generated code runs only in Docker by default (no network, all capabilities dropped, read-only filesystem, resource limits). To run it on the host, switch off "Use Docker sandbox" in Settings and confirm the warning dialog. If Docker is missing, BenchForge refuses to run the code and never falls back to the host. Repo/patch (SWE-bench) tests also run in Docker. Set `dockerImage` per repo in the repo sandbox JSON to an image that contains the project's test dependencies, because the container has no network.

## Test

```
go vet ./...
go test -race ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
```

`BENCHFORGE_TEST_ELECTRON_DB=<path to benchforge.db>` additionally opens a copy of a real Electron database.

Live provider test (skipped by default): `BF_LIVE_BASE_URL`, `BF_LIVE_MODEL` (e.g. `gpt-6-luna#effort=low`), `BF_LIVE_KEY`, optional `BF_LIVE_IN_PRICE`/`BF_LIVE_OUT_PRICE` (USD per 1M tokens), then `go test ./internal/runner -run TestLiveProvider -v`.
