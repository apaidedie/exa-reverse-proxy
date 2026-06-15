# 部署准备检查清单

在运行 `scripts\prepare-deployment.bat` 之前，请确认以下事项：

## 📋 部署前检查清单

### 1. 环境配置

#### 检查 .env 文件
打开 `.env` 文件，确认：

```bash
# ✅ 确保所有 Token 至少 16 字符
EXA_PROXY_TOKENS=your-client-token-16-chars-minimum
EXA_ADMIN_TOKENS=your-admin-token-16-chars-minimum
EXA_ADMIN_HEALTHCHECK_TOKEN=your-healthcheck-token-16-chars

# ✅ 管理员 Token 只用于控制台和管理接口，不是 Exa API Key

# ✅ 确保至少配置了一个 Exa API Key
EXA_KEYS=exa_a:your-exa-key:1

# 或者使用文件
EXA_KEYS_FILE=/run/secrets/exa_api_key.txt
# exa_api_key.txt 支持一行一个 key，或 stable_prod_a:your-exa-key:2 这种稳定 id:key:weight 格式。

# 可选：告警 webhook 去重冷却时间
EXA_ALERT_WEBHOOK_COOLDOWN_SECONDS=300
```

#### 生成安全 Token（推荐）
```bash
# PowerShell 中生成随机 Token
# 32 字符的安全 Token
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
```

### 2. Docker 环境

#### 确认 Docker 已安装并运行
```bash
docker --version
docker compose version
```

#### 检查磁盘空间
```bash
# 确保至少有 2GB 可用空间
docker system df
```

### 3. 备份现有数据（如果有）

如果你已经运行过服务，备份数据库：

```bash
# 停止服务
docker compose down

# 备份数据库
copy /data/exa-proxy.sqlite /data/exa-proxy.sqlite.backup
# 或者从 volume 中导出
docker run --rm -v exa_proxy_data:/data -v %cd%:/backup alpine cp /data/exa-proxy.sqlite /backup/
```

---

## 🚀 开始部署

完成上述检查后，运行：

```bash
scripts\prepare-deployment.bat
```

脚本会自动：
1. 检查安全漏洞
2. 运行验证脚本
3. 运行所有测试
4. TypeScript 类型检查
5. 构建 Docker 镜像
6. 创建备份镜像标签

---

## 🧪 部署后验证

### 1. 启动服务
```bash
docker compose up -d
```

### 2. 检查日志
```bash
docker compose logs -f
```

### 3. 健康检查
```bash
curl -H "Authorization: Bearer your-admin-token" http://127.0.0.1:8787/_proxy/health
```

预期响应：
```json
{
  "ok": true,
  "keys": 2,
  "session": null
}
```

### 4. 测试代理功能
```bash
curl -X POST http://127.0.0.1:8787/search \
  -H "Authorization: Bearer your-client-token" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","numResults":1}'
```

### 5. 访问管理控制台
打开浏览器访问：
```
http://127.0.0.1:8787/
```

使用管理员 Token 登录。

---

## 🔄 回滚方案

如果部署后遇到问题，可以快速回滚：

```bash
# 停止服务
docker compose down

# 回滚到备份镜像
docker tag exa-reverse-proxy:pre-optimization-backup exa-reverse-proxy:local

# 重新启动
docker compose up -d
```

---

## 📊 监控指标

部署后持续监控以下指标：

### 性能指标
- `/_proxy/metrics` - Prometheus 指标
- 日志查询响应时间
- CPU 和内存使用率

### 安全指标
- 速率限制触发次数（429 响应）
- 登录失败次数
- 异常请求模式

### 系统健康
- 可用 Key 数量
- 请求成功率
- 平均响应延迟

---

## ⚠️ 常见问题

### Q: Token 长度错误
**问题**: 启动时报错 "All proxy tokens must be at least 16 characters"
**解决**: 更新 `.env` 文件，确保所有 Token ≥ 16 字符

### Q: Docker 构建失败
**问题**: "npm test" 步骤失败
**解决**: 本地先运行 `npm test` 确保通过，然后再构建

### Q: 历史审计日志中的 Token ID 不匹配
**问题**: Token ID 格式变了
**说明**: 这是预期的，新算法使用 HMAC。记录此次变更时间点即可。

---

## 📞 需要帮助？

如果遇到问题，检查：
1. `docs\DOCKER_TROUBLESHOOTING.md` - Docker 常见问题
2. `docs\archive\TEST_FIXES.md` - 历史测试问题修复
3. `docs\archive\OPTIMIZATIONS_SUMMARY.md` - 历史优化技术记录

准备好了就运行 `scripts\prepare-deployment.bat`！
