Set-Location $PSScriptRoot

Write-Host "Cleaning up remaining files..."

# 1. 移动遗漏的脚本
Write-Host "[1/4] Moving remaining scripts..."
if (Test-Path "refactor-project.ps1") { Move-Item "refactor-project.ps1" "scripts/" -Force }

# 2. 处理 exa_api_key.txt - 转换为 JSON 格式
Write-Host "[2/4] Converting exa_api_key.txt to JSON format..."
if (Test-Path "exa_api_key.txt") {
    $note = "# OLD FORMAT - exa_api_key.txt has been replaced by config/secrets.json"
    $note | Out-File "exa_api_key.txt.deprecated" -Encoding UTF8
    Move-Item "exa_api_key.txt" "config/exa_api_key.txt.old" -Force
}

# 3. 删除临时/重复文件
Write-Host "[3/4] Removing duplicate and temp files..."
@(
    "docs/vps-deployment.md",           # 重复，已有 DEPLOYMENT.md
    "docs/deployment-checklist.md"      # 重复，已有 DEPLOYMENT_CHECKLIST.md
) | ForEach-Object {
    if (Test-Path $_) {
        Write-Host "  Removing duplicate: $_"
        Remove-Item $_ -Force
    }
}

# 4. 整理 output 和 tmp 目录
Write-Host "[4/4] Checking temp directories..."
if (Test-Path "output") {
    $size = (Get-ChildItem "output" -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host "  output/ directory: $([math]::Round($size, 2)) MB"
    Write-Host "  (可以安全删除 - 这是测试输出)"
}

if (Test-Path "tmp") {
    Write-Host "  tmp/ directory found (可以安全删除)"
}

if (Test-Path "test-results") {
    Write-Host "  test-results/ directory found (可以安全删除)"
}

if (Test-Path "参考图") {
    Write-Host "  参考图/ directory found (可以安全删除)"
}

Write-Host ""
Write-Host "========================================="
Write-Host " Cleanup Summary"
Write-Host "========================================="
Write-Host ""
Write-Host "Core files (keep):"
Write-Host "  README.md"
Write-Host "  package.json"
Write-Host "  tsconfig.json"
Write-Host "  docker-compose.yml"
Write-Host "  .env"
Write-Host "  .env.example"
Write-Host ""
Write-Host "Organized directories (keep):"
Write-Host "  docs/        - All documentation"
Write-Host "  config/      - Configuration templates"
Write-Host "  scripts/     - Utility scripts"
Write-Host "  src/         - Source code"
Write-Host "  test/        - Test code"
Write-Host ""
Write-Host "Can be safely deleted:"
Write-Host "  output/           - Playwright test output"
Write-Host "  tmp/              - Temporary files"
Write-Host "  test-results/     - Test results cache"
Write-Host "  参考图/           - Reference images"
Write-Host "  dist/             - Build output (regenerated)"
Write-Host "  node_modules/     - Dependencies (run npm install)"
Write-Host ""
Write-Host "To clean up, run:"
Write-Host '  Remove-Item output, tmp, test-results, 参考图 -Recurse -Force'
Write-Host ""
