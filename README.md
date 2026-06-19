# Exa Reverse Proxy

[![CI](https://github.com/apaidedie/exa-reverse-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/apaidedie/exa-reverse-proxy/actions/workflows/ci.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/al1ya/exa-reverse-proxy?logo=docker)](https://hub.docker.com/r/al1ya/exa-reverse-proxy)
[![Docker Image Size](https://img.shields.io/docker/image-size/al1ya/exa-reverse-proxy/latest?logo=docker&label=image%20size)](https://hub.docker.com/r/al1ya/exa-reverse-proxy/tags)
[![Version](https://img.shields.io/badge/version-0.4.9-blue)](https://github.com/apaidedie/exa-reverse-proxy/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Exa API 反向代理，将多把上游 Key 池化为一个统一端点，支持智能调度、自动故障转移和中文运维控制台。

## 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/apaidedie/exa-reverse-proxy/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/apaidedie/exa-reverse-proxy/main/.env.example -o .env

$EDITOR .env   # 设置 EXA_KEYS_ENCRYPTION_SECRET、EXA_PROXY_TOKENS、EXA_ADMIN_TOKENS

docker compose up -d
```

服务默认监听 `127.0.0.1:8787`，建议放在 HTTPS 反向代理（Caddy/Nginx）后面。验证：

```bash
curl -H "Authorization: Bearer <管理员令牌>" http://127.0.0.1:8787/_proxy/health
```

> **控制台预览：** 本地运行 `npm run demo:ui`，打开 `http://127.0.0.1:8787` 即可体验内置 Web UI。

## 功能

- **多 Key 池化** — 多把 Exa API Key 轮询/加权/自适应调度，对下游暴露单一端点
- **智能故障转移** — 自动处理 429 限流、5xx 瞬态错误、超时和连接异常，安全重试
- **密钥管理** — API Key 通过管理接口增删改，AES-256-GCM 加密存储在 SQLite 中
- **资源亲和** — 同一资源的后续请求自动路由到创建该资源的 Key
- **运维控制台** — 内置中文 Web UI，覆盖 Key 状态、请求日志、趋势分析、告警、审计
- **Prometheus 指标** — `/_proxy/metrics` 暴露 Key 计数、P95 延迟、错误分布等指标

## 配置

最小 `.env`：

```dotenv
EXA_KEYS_ENCRYPTION_SECRET=<随机加密密钥>
EXA_PROXY_TOKENS=<客户端令牌，至少16字符>
EXA_ADMIN_TOKENS=<管理员令牌，至少16字符>
```

其余配置均有合理默认值，按需添加即可。完整可选项参见 `.env.example`。

### Key 管理方式

**方式一：环境变量种子（首次启动）**

```dotenv
EXA_KEYS=exa_a:your_key_a:1,exa_b:your_key_b:2
```

**方式二：管理接口（推荐，运行时增删改）**

启动后通过 `POST /_proxy/keys` 添加 Key，值会加密存入 SQLite，重启不丢失。详见下方管理接口章节。

## 管理接口

所有接口需要 `EXA_ADMIN_TOKENS` 中的令牌进行认证。

### Key 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/_proxy/keys` | Key 状态与调度器快照 |
| `POST` | `/_proxy/keys` | 创建 Key（`id`, `value`, `weight`） |
| `PUT` | `/_proxy/keys/:id` | 更新 Key（`value`/`weight`/`enabled`） |
| `DELETE` | `/_proxy/keys/:id` | 删除 Key（至少保留一把） |
| `POST` | `/_proxy/keys/:id/test` | 单 Key 健康检查 |
| `POST` | `/_proxy/keys/:id/disable` | 禁用 Key |
| `POST` | `/_proxy/keys/:id/enable` | 启用 Key |
| `POST` | `/_proxy/keys/:id/reset-circuit` | 清除冷却 |
| `POST` | `/_proxy/keys/:id/secret` | 查看明文（需 `EXA_ADMIN_ALLOW_RAW_KEY_DISPLAY=true`） |
| `POST` | `/_proxy/keys/batch` | 批量 enable/disable/reset/test |

### 日志与可观测

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/_proxy/health` | 服务健康状态 |
| `GET` | `/_proxy/logs` | 请求日志（支持 `limit`/`path`/`status` 过滤） |
| `GET` | `/_proxy/logs/trace/:requestId` | 请求链路追踪 |
| `GET` | `/_proxy/logs/export` | 导出日志 CSV |
| `POST` | `/_proxy/logs/prune` | 清理过期日志 |
| `GET` | `/_proxy/observability` | 趋势、告警、保留策略概览 |
| `GET` | `/_proxy/metrics` | Prometheus 指标 |
| `GET` | `/_proxy/events` | SSE 实时推送流 |

### 审计与会话

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/_proxy/session` | 创建管理会话 |
| `DELETE` | `/_proxy/session` | 注销会话 |
| `GET` | `/_proxy/audit` | 管理操作审计记录 |
| `GET` | `/_proxy/audit/export` | 导出审计 CSV |
| `POST` | `/_proxy/alerts/webhook/test` | 测试告警 Webhook |
| `GET` | `/_proxy/config-summary` | 脱敏运行配置 |
| `GET` | `/_proxy/keys/:id/failures` | 单 Key 故障摘要 |

## 安全

- 上游 Key 以 `x-api-key` 注入，下游请求中的 `Authorization`、`x-api-key` 等头在转发前被剥离
- 管理端明文 Key 默认不展示，需 `EXA_ADMIN_ALLOW_RAW_KEY_DISPLAY=true` 开启，每次查看均记录审计
- 生产环境建议 `EXA_ADMIN_REQUIRE_HTTPS=true`（配合 HTTPS 反向代理）
- 管理会话有过期时间（`EXA_ADMIN_SESSION_TTL_SECONDS`），失败登录有锁定机制
- 请求日志只存内部 Key ID，不存明文 Key 值

## 运维

### SQLite 备份与恢复

```bash
npm run backup:docker
npm run restore:docker -- backups/exa-proxy-state-*.tar.gz --yes
```

### 长期运行维护

```bash
# WAL 检查点 + 压缩
sqlite3 /data/exa-proxy.sqlite "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA integrity_check;"
```

服务启动时自动清理过期请求日志，运行期间持续执行 `EXA_LOG_RETENTION_DAYS` 策略。

## 开发

```bash
npm ci
npm run dev          # 本地启动
npm run verify       # lint + test + build
npm run demo:ui      # 控制台演示（无需真实 Key）
npm run test:e2e     # E2E 测试
```

需要 Node.js 22+。Docker 镜像基于 `node:22-bookworm-slim`。

## 许可

[MIT](LICENSE)
