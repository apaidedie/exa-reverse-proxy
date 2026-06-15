@echo off
chcp 65001 >nul
echo ========================================
echo  Fix Better-SQLite3 Module Issue
echo ========================================
echo.
echo The better-sqlite3 module was compiled for a different Node.js version.
echo This script will rebuild it for your current Node.js version.
echo.
echo Current Node.js version:
node --version
echo.
echo Press any key to rebuild better-sqlite3...
pause >nul

cd /d "%~dp0.."

echo.
echo [1/2] Rebuilding better-sqlite3...
call npm rebuild better-sqlite3
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Rebuild failed
    echo.
    echo Try running: npm install --build-from-source better-sqlite3
    pause
    exit /b 1
)
echo.

echo [2/2] Running tests to verify...
call npm test
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Tests still failing. You may need to:
    echo   1. Delete node_modules folder
    echo   2. Run: npm install
    pause
    exit /b 1
)

echo.
echo ========================================
echo  Successfully fixed better-sqlite3!
echo ========================================
pause
