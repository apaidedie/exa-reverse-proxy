# 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 格式。
项目版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范。

## [0.5.0] - 2026-06-20

### 新增

- 代理路由可选速率限制：`EXA_PROXY_RATE_LIMIT_PER_MINUTE` 环境变量，通过 Fastify 封装上下文实现路由级隔离
- 全局安全响应头：所有响应自动添加 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Strict-Transport-Security`
- Docker Compose 资源限制（512MB 内存 / 1 CPU）与日志轮转配置
- Prometheus 抓取配置文档与 Grafana 预置仪表板（`docs/grafana-dashboard.json`）
- GitHub Release 自动化工作流（`v*.*.*` 标签触发）
- 项目社区文件：`CHANGELOG.md`、`CONTRIBUTING.md`、`.github/PULL_REQUEST_TEMPLATE.md`

### 优化

- `docs/DEPLOYMENT.md` 版本引用更新、新增 Prometheus 监控章节
- 速率限制从管理路由移至代理路由封装上下文，管理端登录仍由账户锁定机制保护

## [0.4.10] - 2026-06-20

### 无障碍

- 侧边栏导航添加 ARIA `tablist`/`tab`/`tabpanel` 角色
- 标签页切换时同步更新 `aria-selected` 状态
- 装饰性导航图标添加 `aria-hidden`，折叠按钮添加 `aria-label`

### 修复

- 移除无效的 `.token-input` CSS 规则

### 更新

- README 版本徽章: 0.1.1 → 0.4.9
- `package.json` 版本号: 0.3.9 → 0.4.9

## [0.4.9] - 2026-06-20

### 优化

- `api()` 的 `extractErrorMessage()` 增加 HTML 错误页面清洗（如 Cloudflare 502）——优先尝试 JSON 解析，回退提取 `<title>`，最终使用 HTTP 状态文本

### 移除

- 密钥列表表格中移除权重列（始终显示 1，且 UI 不可编辑）；详情面板中保留显示

## [0.4.8] - 2026-06-20

### 移除

- 移除冗余的侧边栏品牌区块，避免"Exa 代理"重复显示
- 清理关联的 CSS 规则（`.sidebar-brand`、`.sidebar-mark`、`.sidebar-title`）

## [0.4.7] - 2026-06-20

### 新增

- 新增 `httpStatusClass` 辅助函数，内置 `Number.isFinite` NaN 安全防护
- 日志搜索、路径过滤、关键词过滤添加 250ms 防抖
- 剪贴板写入添加 `try/catch`，失败时向用户反馈提示

### 优化

- 替换内联的 NaN 不安全状态码分类逻辑，统一使用 `httpStatusClass`
- `showToast` 计时器从函数属性改为模块级变量
- SSE 重连计时器在 `closeEventStream` 时正确清理
- 自动刷新计时器增加 `eventRefreshPending` 标志检查及 `Math.max(5000, ...)` 最小间隔保护
- `renderConfigSummary` 缓存 9 个 `el()` DOM 查询
- 替换 `JSON.stringify` 日志搜索为定向 7 字段搜索

### 修复

- 移除 `renderDetails()` 末尾多余的 `renderKeys()` 调用（导致双重渲染）
- 移除 `state.js` 中未使用的 `filterMap` 导出
- 移除 3 条无效 CSS 规则

## [0.4.6] - 2026-06-20

### 修复

- 修复切换按钮初始文本与默认脱敏状态不一致的问题（脱敏显示 → 显示原文）

## [0.4.5] - 2026-06-20

### 优化

- 详情面板按钮标签统一为 4 字格式
- "重置熔断"重命名为"重置冷却"，保持术语一致

## [0.4.4] - 2026-06-20

### 修复

- 详情面板操作区从 4 列布局回退为 2 列，修复按钮文字换行问题

## [0.4.3] - 2026-06-20

### 优化

- 压缩密钥详情面板高度，消除不必要的滚动条

## [0.4.2] - 2026-06-20

### 修复

- 解决 7 项代码审查问题

## [0.4.1] - 2026-06-20

### 修复

- 侧边栏重构后恢复版本号显示

## [0.4.0] - 2026-06-20

### 新增

- 管理后台 UI 全面重构为专业侧边栏布局，采用标签页导航

## [0.3.8] - 早期版本

### 新增

- 管理后台请求日志中显示搜索查询内容
- 管理后台 UI 采用标签页导航并简化顶部栏

### 优化

- 多轮布局与视觉细节打磨

## [0.3.0] - 早期版本

### 新增

- 加密 API 密钥存储（SQLite），支持管理后台增删改查
- 管理后台支持批量导入密钥
- 零密钥启动支持（无密钥时返回 503，添加密钥后自动恢复）

### 优化

- Exa API 端点优化与可靠性提升
- CSP 合规性修复

## [0.1.0] - 初始版本

### 新增

- Exa 反向代理控制台初始版本
- Docker 部署支持
- MIT 开源许可证及社区文件

[0.4.10]: https://github.com/user/exa-reverse-proxy/compare/v0.4.9...v0.4.10
[0.4.9]: https://github.com/user/exa-reverse-proxy/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/user/exa-reverse-proxy/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/user/exa-reverse-proxy/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/user/exa-reverse-proxy/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/user/exa-reverse-proxy/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/user/exa-reverse-proxy/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/user/exa-reverse-proxy/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/user/exa-reverse-proxy/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/user/exa-reverse-proxy/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/user/exa-reverse-proxy/compare/v0.3.8...v0.4.0
[0.3.8]: https://github.com/user/exa-reverse-proxy/compare/v0.3.0...v0.3.8
[0.3.0]: https://github.com/user/exa-reverse-proxy/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/user/exa-reverse-proxy/releases/tag/v0.1.0
