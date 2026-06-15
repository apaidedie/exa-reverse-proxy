@echo off
echo ========================================
echo  Apply Modern UI Design
echo ========================================
echo.
echo This will replace the current UI with a modern, clean design.
echo.
echo Changes:
echo  - Larger spacing and cleaner layout
echo  - More prominent key metrics (bigger fonts)
echo  - Softer shadows and gradients
echo  - Better visual hierarchy
echo  - Smooth animations
echo.
echo The original CSS will be backed up.
echo.
pause

cd /d "%~dp0.."

echo.
echo [1/3] Backing up original CSS...
copy src\admin-ui\admin.css src\admin-ui\admin-original.css.backup
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Backup failed
    pause
    exit /b 1
)
echo Backup saved to: src\admin-ui\admin-original.css.backup

echo.
echo [2/3] Applying modern design...
copy /Y src\admin-ui\admin-modern.css src\admin-ui\admin.css
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to apply new design
    pause
    exit /b 1
)

echo.
echo [3/3] Rebuilding assets...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: Build failed, but CSS is updated
    echo You may need to run: npm run build manually
)

echo.
echo ========================================
echo  Modern UI Applied Successfully!
echo ========================================
echo.
echo Next steps:
echo  1. If using Docker: docker compose build
echo  2. Restart service: docker compose restart (or npm start)
echo  3. Refresh your browser to see the new design
echo.
echo To rollback:
echo  copy src\admin-ui\admin-original.css.backup src\admin-ui\admin.css
echo  npm run build
echo.
pause
