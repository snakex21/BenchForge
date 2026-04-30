@echo off
title BenchForge - Testy

cd /d "%~dp0"

echo.
echo ========================================
echo   BenchForge - Testy jednostkowe
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

echo Uruchamianie testow...
echo.
cd frontend
call npm test

echo.
echo ========================================
if errorlevel 1 (
    echo [!] Niektore testy nie przeszly!
) else (
    echo [OK] Wszystkie testy przeszly!
)
echo ========================================
echo.
pause
