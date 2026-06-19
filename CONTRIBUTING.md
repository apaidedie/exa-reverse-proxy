# 贡献指南

感谢你对本项目的关注！以下是参与开发的相关说明。

## 开发环境搭建

- **Node.js** 22 或更高版本（`engines.node >= 22`）
- **Docker**（用于本地容器化测试，可选）

克隆仓库后安装依赖：

```bash
git clone <repo-url>
cd exa-reverse-proxy
npm install
```

## 开发流程

```bash
# 启动开发服务器（tsx watch 模式）
npm run dev

# 运行完整验证（代码扫描 + 类型检查 + 测试 + 审计 + 构建）
npm run verify
```

常用命令速查：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动带热重载的开发服务器 |
| `npm run build` | TypeScript 编译并复制静态资源 |
| `npm test` | 运行单元测试（vitest） |
| `npm run test:e2e` | 运行端到端测试（Playwright） |
| `npm run lint` | 仅做 TypeScript 类型检查 |
| `npm run verify` | 运行全部验证流程 |

## 代码规范

- 使用 **ES Modules**（`import` / `export`），不使用 CommonJS。
- 遵循 **TypeScript strict 模式**，不允许使用 `any`，除非有充分理由并附注释说明。
- `admin-ui` 目录下的前端代码使用 **vanilla JavaScript**，不引入框架。
- 面向用户的界面文案统一使用 **中文**。

## 提交规范

请遵循 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

常用类型：

- `feat` — 新功能
- `fix` — 修复缺陷
- `refactor` — 重构（不影响功能）
- `docs` — 文档变更
- `test` — 测试相关
- `chore` — 构建 / 工具链变更

示例：

```
feat(proxy): 支持流式响应透传

添加对上游 SSE 流式响应的透传能力，降低首字节延迟。

Closes #42
```

## 测试要求

- 提交前必须通过全部测试：`npm test` 和 `npm run lint`。
- 新增功能需附带对应的单元测试或集成测试。
- 修复缺陷时，建议补充回归测试用例以防止问题复现。
- 运行 `npm run verify` 可一次性完成所有检查。
