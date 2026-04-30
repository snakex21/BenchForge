@echo off
title BenchForge - Build Release

cd /d "%~dp0"

echo.
echo ========================================
echo   BenchForge - Build Release (Windows)
echo ========================================
echo.
echo Tworzenie:
echo   - NSIS Installer (.exe)
echo   - Portable (.exe)
echo   - ZIP Archive (.zip)
echo   - SHA256 Checksums
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [!] BLAD: Node.js nie znaleziony!
    echo Pobierz i zainstaluj z: https://nodejs.org
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [!] BLAD: npm nie znaleziony!
    pause
    exit /b 1
)

if not exist node_modules\electron\ (
    echo Instalowanie zaleznosci desktopowych...
    call npm install
    if errorlevel 1 (
        echo [!] BLAD: Instalacja zaleznosci desktopowych nie powiodla sie!
        pause
        exit /b 1
    )
)

if not exist frontend\node_modules\ (
    echo Instalowanie zaleznosci frontendu...
    cd frontend
    call npm install
    cd ..
    if errorlevel 1 (
        echo [!] BLAD: Instalacja zaleznosci frontendu nie powiodla sie!
        pause
        exit /b 1
    )
)

echo.
echo [1/3] Budowanie frontendu...
echo.
cd frontend
call npm run build
cd ..
if errorlevel 1 (
    echo [!] BLAD: Budowanie frontendu nie powiodlo sie!
    pause
    exit /b 1
)

echo.
echo [2/3] Tworzenie installerow...
echo.
call npx electron-builder --win nsis portable zip --publish never
if errorlevel 1 (
    echo [!] BLAD: Tworzenie installerow nie powiodlo sie!
    pause
    exit /b 1
)

echo.
echo [3/3] Generowanie checksum...
echo.
if exist scripts\checksums.cjs (
    node scripts\checksums.cjs release
)

echo.
echo ========================================
echo [OK] Build zakonczony pomyslnie!
echo ========================================
echo.
echo Pliki w folderze release/:
echo.
dir /b release\*.exe release\*.zip release\*.txt 2>nul
echo.
echo ========================================
echo.
pause
