@echo off
title BenchForge - Test i Build

cd /d "%~dp0"

echo.
echo ========================================
echo   BenchForge - Test i Build Release
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [!] BLAD: Node.js nie znaleziony!
    echo Pobierz i zainstaluj z: https://nodejs.org
    pause
    exit /b 1
)

echo [1/4] Uruchamianie testow...
echo.
cd frontend
call npm test
if errorlevel 1 (
    echo.
    echo [!] BLAD: Testy nie przeszly! Napraw bledy przed buildem.
    pause
    exit /b 1
)
cd ..

echo.
echo [2/4] Budowanie frontendu...
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
echo [3/4] Tworzenie installerow...
echo.
call npx electron-builder --win nsis portable zip --publish never
if errorlevel 1 (
    echo [!] BLAD: Tworzenie installerow nie powiodlo sie!
    pause
    exit /b 1
)

echo.
echo [4/4] Generowanie checksum...
echo.
if exist scripts\checksums.cjs (
    node scripts\checksums.cjs release
)

echo.
echo ========================================
echo [OK] Test i Build zakonczone pomyslnie!
echo ========================================
echo.
echo Pliki w folderze release/:
echo.
dir /b release\*.exe release\*.zip release\*.txt 2>nul
echo.
echo Gotowe do wrzucenia na GitHub Releases!
echo.
echo ========================================
echo.
pause
