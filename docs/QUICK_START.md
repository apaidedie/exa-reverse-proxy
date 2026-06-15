# 快速启动开发环境指南

## ⚠️ 重要：配置 .env 文件

我已经为你创建了 `.env` 文件，但你需要修改以下内容：

### 必须修改的配置

1. **EXA_KEYS** - 替换为你真实的 Exa API Key
   ```env
   EXA_KEYS=exa_test:your-real-exa-api-key-here:1
   ```
   改为：
   ```env
   EXA_KEYS=exa_test:你的真实EXA_API_KEY:1
   ```

2. **EXA_PROXY_TOKENS** - 客户端令牌（已设置为 16+ 字符，可直接使用）
   ```env
   EXA_PROXY_TOKENS=dev-client-token-1234567890
   ```

3. **EXA_ADMIN_TOKENS** - 管理员令牌（已设置为 16+ 字符，可直接使用）
   ```env
   EXA_ADMIN_TOKENS=dev-admin-token-1234567890
   ```

## 🚀 启动步骤

### 快速测试（不需要真实 Exa Key）

如果你只是想看 UI，可以暂时注释掉上游调用的验证：

1. 打开 `.env`
2. 确保所有 Token 都至少 16 字符（已经设置好了）
3. 运行：
   ```bash
   npm start
   ```
4. 浏览器访问：`http://127.0.0.1:8787/`
5. 使用这个令牌登录：`dev-admin-token-1234567890`

### 生产使用（需要真实 Exa Key）

1. 获取你的 Exa API Key（从 https://exa.ai）
2. 修改 `.env` 中的 `EXA_KEYS`
3. 修改 Token 为更安全的值
4. 运行服务

## 🎨 查看新 UI

```bash
# 1. 启动服务
npm start

# 2. 浏览器打开
# http://127.0.0.1:8787/

# 3. 登录
# 管理员令牌: dev-admin-token-1234567890
```

## 🔧 配置说明

### Token 长度要求
所有 Token（`EXA_PROXY_TOKENS` 和 `EXA_ADMIN_TOKENS`）必须 **至少 16 字符**。

这是我们的安全优化之一，当前配置已满足要求：
- ✅ `dev-client-token-1234567890` (26 字符)
- ✅ `dev-admin-token-1234567890` (26 字符)

### 生成安全 Token（可选）

PowerShell 中生成随机 Token：
```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
```

## ⚡ 常见问题

### Q: "EXA_PROXY_TOKENS is required"
**A:** `.env` 文件不存在或配置有误。我已经创建了，直接 `npm start` 即可。

### Q: "All proxy tokens must be at least 16 characters"
**A:** Token 太短。当前配置已经是 26 字符，没问题。

### Q: 没有 Exa API Key 怎么办？
**A:** 可以先用假的 Key 启动服务查看 UI（真实请求会失败，但不影响 UI 展示）

### Q: 如何查看新 UI？
**A:**
```bash
npm start
# 浏览器: http://127.0.0.1:8787/
# 登录令牌: dev-admin-token-1234567890
```

---

**现在直接运行 `npm start` 就可以启动了！** 🚀
