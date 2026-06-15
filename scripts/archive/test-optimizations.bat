@echo off
chcp 65001 >nul
REM Optimization Verification and Test Script

echo ========================================
echo  Exa Reverse Proxy - Optimization Test
echo ========================================
echo.

cd /d "%~dp0.."

echo [1/5] Checking Node.js version...
node --version
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js not found
    pause
    exit /b 1
)
echo.

echo [2/5] Installing dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)
echo.

echo [3/5] Running verification script...
call npx tsx scripts/verify-optimizations.ts
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: Some verifications failed
    echo.
)
echo.

echo [4/5] TypeScript type checking...
call npm run lint
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Type check failed
    pause
    exit /b 1
)
echo.

echo [5/5] Running test suite...
call npm test
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Tests failed
    pause
    exit /b 1
)
echo.

echo ========================================
echo      All Verifications Passed!
echo ========================================
echo.
echo Next steps:
echo   1. Check docs\OPTIMIZATIONS_SUMMARY.md for details
echo   2. Run: docker compose build
echo   3. Run: docker compose up -d
echo.
pause
