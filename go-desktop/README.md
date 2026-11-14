# BenchForge desktop: Go + WebView2 host

This replaces the Electron main process. The React UI from `../frontend` is unchanged and embedded into a single `BenchForge.exe`, which is about 16.5 MB and needs the Microsoft Edge WebView2 Runtime (included with Windows 10 and 11).

See `../docs/port-go-webview.md` for the architecture, the parity checklist, the security changes and the measurements.

## Build

Requirements: Go (the version in `go.mod`; it is fetched automatically), MinGW-w64 `gcc` (webview_go uses CGO), and Node 22 for the UI build.

```
cd frontend && npm ci && cd ..
go-desktop\build.bat 1.1.0
```

`build.bat` runs `npm run build:go`, which writes the UI to `internal/webui/dist`. It then builds with `-trimpath -ldflags "-H windowsgui -s -w"`.

## Run

`BenchForge.exe` stores everything in `data\` next to the exe: `benchforge.db`, `artifacts\`, the WebView2 profile and a log. You can override the location with `BENCHFORGE_DATA_DIR`. An existing `data\benchforge.db` from the Electron build opens as is, and stored API keys stay readable.

`-debug` turns on WebView2 devtools.

## Code execution policy

Model-generated code runs only in Docker by default (no network, all capabilities dropped, read-only filesystem, resource limits). To run it on the host, switch off "Use Docker sandbox" in Settings and confirm the warning dialog. If Docker is missing, BenchForge refuses to run the code and never falls back to the host.

## Test

```
go vet ./...
go test -race ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
```

`BENCHFORGE_TEST_ELECTRON_DB=<path to benchforge.db>` additionally opens a copy of a real Electron database.
