@echo off
setlocal
REM BenchForge Go + WebView2 build.
REM   build.bat [version] [--skip-ui]
REM 1. builds the unchanged React UI into internal\webui\dist (needs Node 22 + npm ci in ..\frontend)
REM 2. builds a single BenchForge.exe: -s -w (no symbols), -trimpath (no local paths),
REM    -H windowsgui (no console). CGO is required by webview_go (MinGW-w64 gcc).

set VERSION=%~1
if "%VERSION%"=="" set VERSION=dev
if /I "%VERSION%"=="--skip-ui" set VERSION=dev

if /I not "%~2"=="--skip-ui" if /I not "%~1"=="--skip-ui" (
  echo Building UI ...
  pushd "%~dp0..\frontend"
  call npm run build:go
  if errorlevel 1 (
    popd
    echo UI build FAILED.
    exit /b 1
  )
  popd
)

set CGO_ENABLED=1
set GOOS=windows
set GOARCH=amd64
pushd "%~dp0"
echo Building BenchForge.exe (version %VERSION%) ...
go build -trimpath -ldflags="-H windowsgui -s -w -X main.version=%VERSION%" -o BenchForge.exe .\cmd\benchforge
if errorlevel 1 (
  popd
  echo Build FAILED.
  exit /b 1
)
popd
echo OK -^> %~dp0BenchForge.exe
endlocal
