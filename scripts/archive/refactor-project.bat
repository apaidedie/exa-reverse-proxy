@echo off
chcp 65001 >nul
echo ========================================
echo  项目结构规范化
echo ========================================
echo.
echo 这将重新组织项目文件结构：
echo  - 创建 docs/ config/ scripts/ 目录
echo  - 移动文档到 docs/
echo  - 移动配置到 config/
echo  - 移动脚本到 scripts/
echo  - 改用 JSON 格式存储 secrets
echo.
echo 按任意键继续，或 Ctrl+C 取消...
pause >nul

cd /d "%~dp0.."

REM 1. 创建目录结构
echo.
echo [1/5] 创建目录结构...
if not exist "docs" mkdir docs
if not exist "config" mkdir config
if not exist "config\secrets" mkdir config\secrets
if not exist "scripts" mkdir scripts

REM 2. 移动文档文件
echo [2/5] 整理文档文件...
if exist "OPTIMIZATIONS_SUMMARY.md" move "OPTIMIZATIONS_SUMMARY.md" "docs\" >nul 2>&1
if exist "OPTIMIZATION_CHANGELOG.md" move "OPTIMIZATION_CHANGELOG.md" "docs\" >nul 2>&1
if exist "FINAL_REPORT.md" move "FINAL_REPORT.md" "docs\" >nul 2>&1
if exist "NEXT_STEPS.md" move "NEXT_STEPS.md" "docs\" >nul 2>&1
if exist "TEST_FIXES.md" move "TEST_FIXES.md" "docs\" >nul 2>&1
if exist "TEST_FAILURE_ANALYSIS.md" move "TEST_FAILURE_ANALYSIS.md" "docs\" >nul 2>&1
if exist "DOCKER_TROUBLESHOOTING.md" move "DOCKER_TROUBLESHOOTING.md" "docs\" >nul 2>&1
if exist "DOCKER_HUB_GUIDE.md" move "DOCKER_HUB_GUIDE.md" "docs\DEPLOYMENT.md" >nul 2>&1
if exist "NEW_UI_README.md" move "NEW_UI_README.md" "docs\UI_GUIDE.md" >nul 2>&1
if exist "QUICK_START.md" move "QUICK_START.md" "docs\" >nul 2>&1
if exist "DEPLOYMENT_CHECKLIST.md" move "DEPLOYMENT_CHECKLIST.md" "docs\" >nul 2>&1

REM 3. 移动配置文件
echo [3/5] 整理配置文件...
if exist "docker-compose.vps.yml" move "docker-compose.vps.yml" "config\" >nul 2>&1

REM 4. 移动脚本文件
echo [4/5] 整理脚本文件...
if exist "publish-docker-hub.bat" move "publish-docker-hub.bat" "scripts\" >nul 2>&1
if exist "apply-modern-ui.bat" move "apply-modern-ui.bat" "scripts\" >nul 2>&1
if exist "prepare-deployment.bat" move "prepare-deployment.bat" "scripts\" >nul 2>&1
if exist "test-optimizations.bat" move "test-optimizations.bat" "scripts\" >nul 2>&1
if exist "fix-sqlite.bat" move "fix-sqlite.bat" "scripts\" >nul 2>&1
if exist "check-docker.bat" move "check-docker.bat" "scripts\" >nul 2>&1
if exist "test-optimizations.sh" move "test-optimizations.sh" "scripts\" >nul 2>&1

REM 移动验证脚本到 scripts
if exist "scripts\verify-optimizations.ts" (
    echo verify-optimizations.ts already in scripts/
) else (
    if exist "verify-optimizations.ts" move "verify-optimizations.ts" "scripts\" >nul 2>&1
)

REM 5. 创建 secrets 配置示例
echo [5/5] 创建配置示例...
if not exist "config\secrets.example.json" (
    echo {> config\secrets.example.json
    echo   "exaKeys": [>> config\secrets.example.json
    echo     {>> config\secrets.example.json
    echo       "id": "exa_key_1",>> config\secrets.example.json
    echo       "key": "your-exa-api-key-here",>> config\secrets.example.json
    echo       "weight": 1,>> config\secrets.example.json
    echo       "enabled": true,>> config\secrets.example.json
    echo       "note": "Production key 1">> config\secrets.example.json
    echo     }>> config\secrets.example.json
    echo   ],>> config\secrets.example.json
    echo   "proxyTokens": [>> config\secrets.example.json
    echo     "replace-with-16-char-min-client-token">> config\secrets.example.json
    echo   ],>> config\secrets.example.json
    echo   "adminTokens": [>> config\secrets.example.json
    echo     "replace-with-16-char-min-admin-token">> config\secrets.example.json
    echo   ]>> config\secrets.example.json
    echo }>> config\secrets.example.json
)

REM 清理临时备份文件
echo.
echo [清理] 删除临时文件...
if exist "src\admin-ui\admin-original-backup.css" del "src\admin-ui\admin-original-backup.css" >nul 2>&1
if exist "admin-original-backup.txt" del "admin-original-backup.txt" >nul 2>&1

echo.
echo ========================================
echo  规范化完成！
echo ========================================
echo.
echo 新的项目结构:
echo   docs/           - 所有文档
echo   config/         - 配置文件和模板
echo   scripts/        - 工具脚本
echo   src/            - 源代码
echo   test/           - 测试代码
echo.
echo 下一步:
echo   1. 查看 docs/DEPLOYMENT.md 了解部署
echo   2. 使用 config/secrets.example.json 创建 secrets 配置
echo   3. 运行 scripts/publish-docker-hub.bat 发布镜像
echo.
pause
