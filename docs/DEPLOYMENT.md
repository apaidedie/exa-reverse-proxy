# Docker Hub 发布与部署指南

## 已发布镜像

```text
al1ya/exa-reverse-proxy:latest
al1ya/exa-reverse-proxy:0.1.1
```

## VPS 部署

### 1. 准备环境

```bash
mkdir ~/exa-proxy && cd ~/exa-proxy
curl -fsSL https://raw.githubusercontent.com/apaidedie/exa-reverse-proxy/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/apaidedie/exa-reverse-proxy/main/.env.example -o .env
```

### 2. 配置 `.env`

至少设置三项：

```env
EXA_KEYS_ENCRYPTION_SECRET=<随机加密密钥，建议 32 字符>
EXA_PROXY_TOKENS=<客户端令牌，至少 16 字符>
EXA_ADMIN_TOKENS=<管理员令牌，至少 16 字符>
```

生成随机密钥：`openssl rand -hex 16`

### 3. 启动

```bash
docker compose pull
docker compose up -d
```

### 4. 添加 Exa Key

通过管理接口添加，值会加密存入 SQLite：

```bash
curl -X POST http://127.0.0.1:8787/_proxy/keys \
  -H "Authorization: Bearer <管理员令牌>" \
  -H "Content-Type: application/json" \
  -d '{"id":"exa_01","value":"你的Exa API Key","weight":1}'
```

### 5. 验证

```bash
curl -H "Authorization: Bearer <管理员令牌>" http://127.0.0.1:8787/_proxy/health
```

---

## 发布到 Docker Hub

### GitHub Actions 自动发布

在仓库 Settings -> Secrets and variables -> Actions 中添加 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN`，打 tag 触发：

```bash
git tag v0.1.2
git push origin v0.1.2
```

### 手动发布

```bash
scripts\publish-docker-hub.bat
```

或手动操作：

```bash
docker compose build
docker tag exa-reverse-proxy:local <用户名>/exa-reverse-proxy:0.1.2
docker push <用户名>/exa-reverse-proxy:0.1.2
```

---

## 运维命令

```bash
# 查看日志
docker compose logs -f

# 更新镜像
docker compose pull && docker compose up -d && docker image prune -f

# 备份 SQLite 状态
npm run backup:docker

# 恢复（需 --yes 确认）
npm run restore:docker -- backups/exa-proxy-state-*.tar.gz --yes

# 长期运行 WAL 维护
sqlite3 /data/exa-proxy.sqlite "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA integrity_check;"
```

## Nginx 反向代理

```nginx
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
    }
}
```

## 常见问题

**忘记管理员令牌？** 修改 `.env` 中的 `EXA_ADMIN_TOKENS`，然后 `docker compose restart`。

**数据会丢失吗？** 数据存在 Docker Volume 中，不删 Volume 就不丢。

**多架构支持？** `docker buildx build --platform linux/amd64,linux/arm64 -t <镜像> --push .`
