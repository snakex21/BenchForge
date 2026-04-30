@echo off
title BenchForge - Sprawdzanie tlumaczen

cd /d "%~dp0"

echo.
echo ========================================
echo   BenchForge - Sprawdzanie tlumaczen
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [!] BLAD: Node.js nie znaleziony!
    echo Pobierz i zainstaluj z: https://nodejs.org
    pause
    exit /b 1
)

call npm run i18n:check

echo.
echo ========================================
if errorlevel 1 (
    echo [!] Znaleziono problem w tlumaczeniach!
) else (
    echo [OK] Wszystkie tlumaczenia sa kompletne!
)
echo ========================================
echo.
pause
