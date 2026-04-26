@echo off
title BenchForge Desktop App (Electron)

cd /d "%~dp0"

echo.
echo ========================================
echo   BenchForge Desktop App (Electron)
echo ========================================
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

echo Budowanie frontendu i uruchamianie Electron...
call npm start

if errorlevel 1 (
    echo.
    echo [!] BLAD: Uruchomienie Electron nie powiodlo sie!
    pause
    exit /b 1
)
