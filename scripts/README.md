# 脚本目录

## 常用脚本

- `backup-state.mjs` / `restore-state.mjs` - 备份和恢复 Docker volume 中的 SQLite 状态。
- `scan-secrets.mjs` - 扫描已跟踪文件中的明显密钥材料。
- `publish-docker-hub.bat` - 手动构建并推送 Docker Hub 镜像。
- `prepare-deployment.bat` - 部署前检查和准备。
- `check-docker.bat` / `fix-sqlite.bat` - 本地排查辅助脚本。
- `copy-admin-ui.mjs`, `demo-ui-server.ts`, `verify-optimizations.ts` - 开发和验证辅助脚本。

## 归档脚本

`archive/` 保存已经完成的一次性整理、重构和旧优化脚本，避免它们混在常用入口里。
