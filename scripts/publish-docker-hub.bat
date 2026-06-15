@echo off
chcp 65001 >nul
echo ========================================
echo  Publish to Docker Hub
echo ========================================
echo.

cd /d "%~dp0.."

REM 检查 Docker 是否运行
docker ps >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Docker is not running
    echo Please start Docker Desktop first
    pause
    exit /b 1
)

echo Please enter your Docker Hub information:
echo.
set /p DOCKER_USERNAME="Docker Hub username (default: al1ya): "
set /p IMAGE_NAME="Image name (default: exa-reverse-proxy): "
set /p IMAGE_TAG="Image tag (default: latest): "

if "%DOCKER_USERNAME%"=="" set DOCKER_USERNAME=al1ya
if "%IMAGE_NAME%"=="" set IMAGE_NAME=exa-reverse-proxy
if "%IMAGE_TAG%"=="" set IMAGE_TAG=latest

echo.
echo Will publish to: %DOCKER_USERNAME%/%IMAGE_NAME%:%IMAGE_TAG%
echo.
echo Press any key to continue, or Ctrl+C to cancel...
pause >nul

echo.
echo [1/4] Building Docker image...
docker compose build
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

echo.
echo [2/4] Tagging image...
docker tag exa-reverse-proxy:local %DOCKER_USERNAME%/%IMAGE_NAME%:%IMAGE_TAG%
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Tagging failed
    pause
    exit /b 1
)

echo.
echo [3/4] Logging in to Docker Hub...
echo Please enter your Docker Hub password when prompted
docker login -u %DOCKER_USERNAME%
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Login failed
    pause
    exit /b 1
)

echo.
echo [4/4] Pushing image to Docker Hub...
docker push %DOCKER_USERNAME%/%IMAGE_NAME%:%IMAGE_TAG%
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Push failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo  Successfully Published!
echo ========================================
echo.
echo Image: %DOCKER_USERNAME%/%IMAGE_NAME%:%IMAGE_TAG%
echo.
echo To use on VPS:
echo   docker pull %DOCKER_USERNAME%/%IMAGE_NAME%:%IMAGE_TAG%
echo   docker run -d -p 127.0.0.1:8787:8787 --env-file .env -v exa_proxy_data:/data -v %%cd%%\exa_api_key.txt:/run/secrets/exa_api_key.txt:ro -e EXA_STATE_PATH=/data/exa-proxy.sqlite -e EXA_KEYS_FILE=/run/secrets/exa_api_key.txt %DOCKER_USERNAME%/%IMAGE_NAME%:%IMAGE_TAG%
echo.
echo Or use docker-compose.deploy.yml and set image: %DOCKER_USERNAME%/%IMAGE_NAME%:%IMAGE_TAG%
echo.
pause
