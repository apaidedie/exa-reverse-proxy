# Docker Hub 发布与一键部署指南

## 已发布镜像

镜像已发布到 Docker Hub:

```text
al1ya/exa-reverse-proxy:latest
al1ya/exa-reverse-proxy:0.1.1
```

分享 GitHub 项目时，用户可以直接使用根目录的 `docker-compose.deploy.yml` 拉取镜像部署，不需要在服务器上构建 TypeScript 项目。

## 发布到 Docker Hub

### GitHub Actions 自动发布

仓库包含两个 workflow：

- `CI`：在 `main` 和 Pull Request 上运行 `npm run verify`、Compose 配置检查和 Docker 构建。
- `Docker Publish`：在 `v*.*.*` 标签或手动触发时构建并推送 `linux/amd64,linux/arm64` 镜像。

在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中添加：

```text
DOCKERHUB_USERNAME=al1ya
DOCKERHUB_TOKEN=你的 Docker Hub Access Token
```

发布新版本：

```bash
git tag v0.1.1
git push origin v0.1.1
```

### 方式 1: 使用自动化脚本（推荐）

```bash
publish-docker-hub.bat
```

脚本会提示你输入：
1. Docker Hub 用户名
2. 镜像名称（默认：exa-reverse-proxy）
3. 标签（默认：latest）

然后自动完成：
- ✅ 构建镜像
- ✅ 打标签
- ✅ 登录 Docker Hub
- ✅ 推送镜像

### 方式 2: 手动操作

```bash
# 1. 构建镜像
docker compose build

# 2. 登录 Docker Hub
docker login

# 3. 打标签
docker tag exa-reverse-proxy:local al1ya/exa-reverse-proxy:0.1.1
docker tag exa-reverse-proxy:local al1ya/exa-reverse-proxy:latest

# 4. 推送到 Docker Hub
docker push al1ya/exa-reverse-proxy:0.1.1
docker push al1ya/exa-reverse-proxy:latest
```

---

## VPS 一键部署

### 准备工作

1. **在 VPS 上创建项目目录**
```bash
mkdir ~/exa-proxy
cd ~/exa-proxy
```

2. **复制配置模板**
```bash
cp .env.example .env
```

3. **写入真实 Exa Key**
```bash
printf '%s\n' 'stable_prod_a:你的真实ExaKey1:2' 'stable_prod_b:你的真实ExaKey2:1' > exa_api_key.txt
chmod 600 exa_api_key.txt
```

4. **编辑 `.env`**

至少设置 `EXA_PROXY_TOKENS`、`EXA_ADMIN_TOKENS` 和 `EXA_ADMIN_HEALTHCHECK_TOKEN`，并确保 `EXA_KEYS=` 保持为空或替换成真实 `id:key:weight` 条目。

### 一键部署

```bash
# 1. 拉取镜像
docker compose -f docker-compose.deploy.yml pull

# 2. 启动服务
docker compose -f docker-compose.deploy.yml up -d

# 3. 查看日志
docker compose -f docker-compose.deploy.yml logs -f

# 4. 检查状态
docker compose -f docker-compose.deploy.yml ps
```

---

## 📄 VPS 配置文件

### `.env` 文件（必须配置）

```env
# Exa API Keys
# 推荐把真实 Key 放在 exa_api_key.txt；支持一行一个 key，或 id:key:weight 稳定格式。
EXA_KEYS=

# 客户端令牌（至少 16 字符）
EXA_PROXY_TOKENS=你的客户端Token至少16字符

# 管理员令牌（至少 16 字符）
EXA_ADMIN_TOKENS=你的管理员Token至少16字符
EXA_ADMIN_HEALTHCHECK_TOKEN=你的管理员Token至少16字符

# 数据库路径
EXA_STATE_PATH=/data/exa-proxy.sqlite

# 生产环境建议启用 HTTPS
EXA_ADMIN_REQUIRE_HTTPS=true

# 其他配置保持默认即可
EXA_MAX_ATTEMPTS=3
EXA_FAILURE_THRESHOLD=3
EXA_COOLDOWN_SECONDS=120
```

### `docker-compose.deploy.yml` 文件

```yaml
services:
  exa-proxy:
    image: al1ya/exa-reverse-proxy:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    env_file:
      - .env
    environment:
      HOST: 0.0.0.0
      PORT: 8787
      EXA_STATE_PATH: /data/exa-proxy.sqlite
      EXA_KEYS_FILE: /run/secrets/exa_api_key.txt
      EXA_ADMIN_REQUIRE_HTTPS: "true"
      EXA_ADMIN_ALLOW_RAW_KEY_DISPLAY: "false"
    volumes:
      - exa_proxy_data:/data
      - ./exa_api_key.txt:/run/secrets/exa_api_key.txt:ro

volumes:
  exa_proxy_data:
```

---

## 🔐 安全建议

### 1. 使用强 Token
```bash
# 生成随机 Token（32 字符）
openssl rand -hex 16
```

### 2. 限制访问
```yaml
ports:
  - "127.0.0.1:8787:8787"  # 只监听本地
```

然后使用 Nginx 反向代理 + SSL。

### 3. 启用 HTTPS 验证
```env
EXA_ADMIN_REQUIRE_HTTPS=true
```

### 4. 定期备份
```bash
# 备份 Docker volume 里的 SQLite 状态库
npm run backup:docker

# 恢复时会替换 /data/exa-proxy.sqlite*，必须显式确认
npm run restore:docker -- backups/exa-proxy-state-2026-06-14T00-00-00-000Z.tar.gz --yes
```

---

## 📊 监控和维护

### 查看日志
```bash
docker compose logs -f exa-proxy
```

### 查看统计
```bash
curl -H "Authorization: Bearer 你的管理员Token" \
     http://127.0.0.1:8787/_proxy/health
```

### 更新镜像
```bash
# 1. 拉取最新版本
docker compose -f docker-compose.deploy.yml pull

# 2. 重启服务
docker compose -f docker-compose.deploy.yml up -d

# 3. 清理旧镜像
docker image prune -f
```

### 重启服务
```bash
docker compose restart
```

### 停止服务
```bash
docker compose down
```

---

## 🌐 Nginx 反向代理（可选）

如果想通过域名访问并启用 HTTPS：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## ❓ 常见问题

### Q: 镜像太大怎么办？
**A:** 当前镜像已经使用了 `node:22-bookworm-slim`，体积约 200MB，已经很精简了。

### Q: 如何多架构支持（ARM）？
**A:** 使用 buildx：
```bash
docker buildx build --platform linux/amd64,linux/arm64 -t al1ya/exa-reverse-proxy:latest --push .
```

### Q: 忘记管理员密码怎么办？
**A:** 修改 VPS 上的 `.env` 文件，然后 `docker compose restart`

### Q: 数据会丢失吗？
**A:** 不会，数据存在 Docker Volume 中。只要不删除 Volume，数据就在。

---

## 🎉 完成！

发布后，你就可以在任何 VPS 上快速部署了：

```bash
# 一键部署命令
docker run -d \
  -p 8787:8787 \
  --env-file .env \
  -v exa_proxy_data:/data \
  -v "$PWD/exa_api_key.txt:/run/secrets/exa_api_key.txt:ro" \
  -e EXA_STATE_PATH=/data/exa-proxy.sqlite \
  -e EXA_KEYS_FILE=/run/secrets/exa_api_key.txt \
  --name exa-proxy \
  al1ya/exa-reverse-proxy:latest
```

或者使用 docker-compose 更方便管理！
