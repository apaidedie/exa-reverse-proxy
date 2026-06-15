Set-Location (Join-Path $PSScriptRoot '..')

Write-Host "Creating directories..."
@("docs", "config", "config/secrets", "scripts") | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ | Out-Null }
}

Write-Host "Moving docs..."
@(
    "OPTIMIZATIONS_SUMMARY.md",
    "OPTIMIZATION_CHANGELOG.md",
    "FINAL_REPORT.md",
    "NEXT_STEPS.md",
    "TEST_FIXES.md",
    "TEST_FAILURE_ANALYSIS.md",
    "DOCKER_TROUBLESHOOTING.md",
    "QUICK_START.md",
    "DEPLOYMENT_CHECKLIST.md",
    "PROJECT_REFACTOR_PLAN.md"
) | ForEach-Object {
    if (Test-Path $_) { Move-Item $_ "docs/" -Force }
}

if (Test-Path "DOCKER_HUB_GUIDE.md")  { Move-Item "DOCKER_HUB_GUIDE.md"  "docs/DEPLOYMENT.md" -Force }
if (Test-Path "NEW_UI_README.md")      { Move-Item "NEW_UI_README.md"      "docs/UI_GUIDE.md"   -Force }

Write-Host "Moving config..."
if (Test-Path "docker-compose.vps.yml") { Move-Item "docker-compose.vps.yml" "config/" -Force }

Write-Host "Moving scripts..."
@(
    "publish-docker-hub.bat",
    "apply-modern-ui.bat",
    "prepare-deployment.bat",
    "test-optimizations.bat",
    "test-optimizations.sh",
    "fix-sqlite.bat",
    "check-docker.bat",
    "refactor-project.bat"
) | ForEach-Object {
    if (Test-Path $_) { Move-Item $_ "scripts/" -Force }
}

if (Test-Path "scripts/copy-admin-ui.mjs") {} else {
    # verify-optimizations already in scripts/
}

Write-Host "Cleaning up temp files..."
@(
    "src/admin-ui/admin-original-backup.txt",
    "admin-original-backup.txt",
    "src/admin-ui/admin-modern.css"   # merged into admin.css already
) | ForEach-Object {
    if (Test-Path $_) { Remove-Item $_ -Force }
}

Write-Host ""
Write-Host "Done! New structure:"
Get-ChildItem -Directory | Select-Object -ExpandProperty Name
Write-Host ""
Write-Host "Run: npm test  to verify everything still works."
