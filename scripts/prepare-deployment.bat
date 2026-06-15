@echo off
chcp 65001 >nul
echo ========================================
echo  Deployment Preparation Script
echo ========================================
echo.

cd /d "%~dp0.."

echo [Step 1/6] Checking security vulnerabilities...
call npm audit
echo.
echo Do you want to fix security issues? (Y/N)
set /p FIX_AUDIT=
if /i "%FIX_AUDIT%"=="Y" (
    echo Fixing security issues...
    call npm audit fix
    echo.
)

echo [Step 2/6] Running final verification...
call npx tsx scripts/verify-optimizations.ts
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Verification failed
    pause
    exit /b 1
)
echo.

echo [Step 3/6] Running tests...
call npm test
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Tests failed
    pause
    exit /b 1
)
echo.

echo [Step 4/6] Type checking...
call npm run lint
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Type check failed
    pause
    exit /b 1
)
echo.

echo [Step 5/6] Building Docker image...
call docker compose build
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Docker build failed
    pause
    exit /b 1
)
echo.

echo [Step 6/6] Tagging current version as backup...
call docker tag exa-reverse-proxy:local exa-reverse-proxy:pre-optimization-backup
echo.

echo ========================================
echo  Deployment Preparation Complete!
echo ========================================
echo.
echo Next steps:
echo   1. Update your .env file (ensure tokens are 16+ chars)
echo   2. Run: docker compose up -d
echo   3. Test: curl -H "Authorization: Bearer admin_token" http://127.0.0.1:8787/_proxy/health
echo.
echo Backup image created: exa-reverse-proxy:pre-optimization-backup
echo To rollback: docker tag exa-reverse-proxy:pre-optimization-backup exa-reverse-proxy:local
echo.
pause
