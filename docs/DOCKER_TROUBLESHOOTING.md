# Docker 部署问题解决

## ❌ 问题：Docker Desktop 未运行

**错误信息:**
```
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
```

这表示 Docker Desktop 没有启动。

---

## 解决方案 1: 启动 Docker Desktop（推荐）

### 步骤：

1. **启动 Docker Desktop**
   - 在开始菜单搜索 "Docker Desktop"
   - 点击启动
   - 等待右下角系统托盘图标从橙色变为绿色（完全启动）

2. **验证 Docker 运行状态**
   ```bash
   scripts\check-docker.bat
   ```
   或手动验证：
   ```bash
   docker ps
   docker compose version
   ```

3. **重新运行部署脚本**
   ```bash
   scripts\prepare-deployment.bat
   ```

---

## 解决方案 2: 本地运行（无需 Docker）

如果你不想使用 Docker，可以直接本地运行：

### 1. 构建项目
```bash
npm run build
```

### 2. 启动服务
```bash
npm start
```

服务将在 `http://localhost:8787` 运行

### 3. 验证健康状态
```bash
curl -H "Authorization: Bearer your-admin-token" http://127.0.0.1:8787/_proxy/health
```

### 4. 访问管理控制台
浏览器打开：`http://127.0.0.1:8787/`

---

## 解决方案 3: 安装 Docker Desktop（如果未安装）

如果你的系统没有安装 Docker Desktop：

1. 访问: https://www.docker.com/products/docker-desktop/
2. 下载 Docker Desktop for Windows
3. 安装并启动
4. 等待完全启动后重新运行部署脚本

---

## 关于安全审计

当前项目已升级到 Vitest 4.x，`npm audit --audit-level=high` 返回 0 个漏洞。生产镜像仍会在构建后执行 `npm prune --omit=dev`，只保留运行时依赖。

---

## 当前状态

✅ 所有优化已完成
✅ 验证脚本通过 (9/9)
✅ 完整测试套件通过
✅ 类型检查通过
❌ Docker 构建失败（Docker Desktop 未运行）

---

## 推荐方案

**对于开发/测试:**
- 使用 `npm start` 本地运行即可

**对于生产部署:**
- 启动 Docker Desktop
- 运行 `scripts\prepare-deployment.bat`
- 使用 Docker Compose 部署

---

## 快速命令参考

```bash
# 检查 Docker 状态
scripts\check-docker.bat

# 本地运行（不用 Docker）
npm run build
npm start

# Docker 部署（需要 Docker Desktop 运行）
docker compose build
docker compose up -d

# 查看日志
docker compose logs -f

# 停止服务
docker compose down
```

---

需要我帮你选择哪种部署方式？
