@echo off
chcp 65001 >nul
echo ========================================
echo  Deployment Preparation Script
echo ========================================
echo.

cd /d "%~dp0.."

echo [Step 1/4] Running verify (scan:secrets + lint + test + audit + build)...
call npm run verify
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Verify failed
    pause
    exit /b 1
)
echo.

echo [Step 2/4] Building Docker image...
call docker compose build
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Docker build failed
    pause
    exit /b 1
)
echo.

echo [Step 3/4] Validating compose config...
call docker compose config --no-interpolate >nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Compose config validation failed
    pause
    exit /b 1
)
echo.

echo [Step 4/4] Tagging current version as backup...
call docker tag exa-reverse-proxy:local exa-reverse-proxy:pre-deploy-backup
echo.

echo ========================================
echo  Deployment Preparation Complete!
echo ========================================
echo.
echo Next steps:
echo   1. Update your .env file (ensure tokens are 16+ chars)
echo   2. Run: docker compose up -d
echo   3. Add keys via admin API: POST /_proxy/keys
echo.
echo Backup image: exa-reverse-proxy:pre-deploy-backup
echo To rollback: docker tag exa-reverse-proxy:pre-deploy-backup exa-reverse-proxy:local
echo.
pause
