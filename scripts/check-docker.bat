@echo off
chcp 65001 >nul
echo ========================================
echo  Docker Setup Check
echo ========================================
echo.

cd /d "%~dp0.."

echo Checking if Docker Desktop is running...
docker ps >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo ✓ Docker Desktop is running
    echo.
    docker --version
    docker compose version
    echo.
    echo You can now run: scripts\prepare-deployment.bat
    pause
    exit /b 0
)

echo.
echo ❌ Docker Desktop is not running
echo.
echo Please follow these steps:
echo.
echo 1. Start Docker Desktop application
echo    - Look for Docker Desktop icon in your Start menu
echo    - Wait for it to fully start (icon turns from orange to green in system tray)
echo.
echo 2. After Docker Desktop starts, run this script again to verify
echo.
echo Alternative: Deploy without Docker
echo   If you want to run locally without Docker:
echo   - Run: npm run build
echo   - Run: npm start
echo   - The service will run on http://localhost:8787
echo.
pause
