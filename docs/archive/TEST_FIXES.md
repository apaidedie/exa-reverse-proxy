# 测试失败问题修复指南

## 问题概述

测试运行时遇到两个主要问题：

### 1. better-sqlite3 模块版本不匹配 ❌

**错误信息:**
```
The module 'better_sqlite3.node' was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127.
```

**原因:** better-sqlite3 是一个原生模块，需要针对特定的 Node.js 版本编译。你当前使用的是 Node.js v22.18.0，但模块是为其他版本编译的。

**解决方法:**

**方法 1 - 运行修复脚本（推荐）:**
```bash
fix-sqlite.bat
```

**方法 2 - 手动重新编译:**
```bash
npm rebuild better-sqlite3
```

**方法 3 - 如果方法 2 失败，完全重装:**
```bash
# 删除 node_modules
rmdir /s /q node_modules
# 重新安装
npm install
```

### 2. 测试用例 Token 长度问题 ✅ (已修复)

**错误信息:**
```
All proxy tokens must be at least 16 characters for security
```

**原因:** 我们添加的安全增强要求所有 Token 至少 16 字符，但旧的测试用例使用了短 Token（如 `'client'`）。

**状态:** ✅ 已修复 - 所有测试用例中的 Token 已更新为 16+ 字符。

## 修复步骤

### Step 1: 重新编译 better-sqlite3

```bash
npm rebuild better-sqlite3
```

### Step 2: 再次运行测试

```bash
npm test
```

### Step 3: 如果还有问题

```bash
# 完全重装所有依赖
rmdir /s /q node_modules
npm install
npm test
```

## 预期结果

修复后，所有测试应该通过：

```
✓ test/demo.test.ts (2 tests)
✓ test/routes.test.ts (3 tests)
✓ test/scheduler.test.ts (5 tests)
✓ test/headers.test.ts (2 tests)
✓ test/errors.test.ts (1 test)
✓ test/retry.test.ts (3 tests)
✓ test/auth.test.ts (4 tests)
✓ test/config.test.ts (5 tests)
✓ test/state.test.ts (4 tests)
✓ test/proxy.streaming.test.ts (1 test)
✓ test/proxy.affinity.test.ts (1 test)
✓ test/app.test.ts (4 tests)
✓ test/proxy.failover.test.ts (5 tests)
✓ test/admin.test.ts (29 tests)

Test Files  14 passed (14)
     Tests  69 passed (69)
```

## 关于安全漏洞警告

你可能看到这个警告：
```
5 high severity vulnerabilities
```

这些是依赖包的已知漏洞。查看详情：
```bash
npm audit
```

如果需要修复（可能包含破坏性更改）：
```bash
npm audit fix --force
```

**注意:** 在生产环境部署前建议修复这些漏洞，但测试开发阶段可以暂时忽略。

## 快速测试

如果你只想快速验证修复是否成功，运行：

```bash
npm run lint
```

这只做类型检查，不会触发 better-sqlite3 问题。
