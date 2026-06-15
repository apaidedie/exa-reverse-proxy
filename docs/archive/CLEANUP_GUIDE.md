# 剩余文件处理指南

## 📋 当前根目录文件分析

### ✅ 保留文件（核心文件）
```
E:\codex\Working/
├── README.md                 - 项目说明（保留）
├── package.json              - 项目依赖（保留）
├── package-lock.json         - 锁定版本（保留）
├── tsconfig.json             - TypeScript 配置（保留）
├── docker-compose.yml        - Docker 编排（保留）
├── Dockerfile                - 镜像构建（保留）
├── .env                      - 环境配置（保留）
├── .env.example              - 配置模板（保留）
├── .gitignore                - Git 忽略（保留）
└── .dockerignore             - Docker 忽略（保留）
```

### 📁 保留目录（已整理）
```
├── docs/                     - 所有文档（保留）
├── config/                   - 配置模板（保留）
├── scripts/                  - 工具脚本（保留）
├── src/                      - 源代码（保留）
└── test/                     - 测试代码（保留）
```

### 🗑️ 可以删除的文件/目录

#### 1. 临时文件
```
exa_api_key.txt              - 旧格式，已转为 JSON
refactor-project.ps1         - 已执行完毕
cleanup-project.ps1          - 清理脚本本身
```

#### 2. 测试输出目录（占空间大）
```
output/                      - Playwright 测试输出
tmp/                         - 临时文件
test-results/                - 测试结果缓存
参考图/                      - 参考图片
```

#### 3. 构建输出（可重新生成）
```
dist/                        - 编译输出（npm run build 可重建）
node_modules/                - 依赖包（npm install 可重装）
```

#### 4. 重复的文档（已合并）
```
docs/vps-deployment.md           - 重复（已有 DEPLOYMENT.md）
docs/deployment-checklist.md     - 重复（已有 DEPLOYMENT_CHECKLIST.md）
```

---

## 🧹 自动清理方案

### 方式 1: 运行清理脚本（推荐）
```powershell
powershell -ExecutionPolicy Bypass -File cleanup-project.ps1
```

### 方式 2: 手动清理（保守）

#### Step 1: 删除测试输出（释放空间）
```powershell
Remove-Item output, tmp, test-results, 参考图 -Recurse -Force -ErrorAction SilentlyContinue
```

#### Step 2: 移动旧配置文件
```powershell
# 保留但移动到 config
Move-Item exa_api_key.txt config/exa_api_key.txt.old -Force
```

#### Step 3: 删除临时脚本
```powershell
Remove-Item refactor-project.ps1, cleanup-project.ps1 -Force
```

#### Step 4: 删除重复文档
```powershell
Remove-Item docs/vps-deployment.md, docs/deployment-checklist.md -Force -ErrorAction SilentlyContinue
```

---

## 📊 清理前后对比

### 清理前
```
E:\codex\Working/
├── [杂乱的根目录文件 20+]
├── output/              ← 大量测试输出
├── tmp/                 ← 临时文件
├── test-results/        ← 测试缓存
├── 参考图/              ← 图片
├── exa_api_key.txt      ← 旧格式
├── *.ps1                ← 临时脚本
└── ...
```

### 清理后（推荐）
```
E:\codex\Working/
├── README.md
├── package.json
├── tsconfig.json
├── docker-compose.yml
├── .env
│
├── docs/                ← 所有文档
├── config/              ← 配置模板
│   └── exa_api_key.txt.old  ← 旧配置备份
├── scripts/             ← 工具脚本
├── src/                 ← 源代码
├── test/                ← 测试
│
├── dist/                ← 构建输出（可删除）
└── node_modules/        ← 依赖（可删除）
```

---

## 🎯 推荐操作

### 快速清理（释放磁盘空间）
```powershell
# 删除测试输出和临时文件
Remove-Item output, tmp, test-results, 参考图 -Recurse -Force

# 移动旧配置
Move-Item exa_api_key.txt config/exa_api_key.txt.old -Force

# 删除临时脚本
Remove-Item refactor-project.ps1, cleanup-project.ps1 -Force

# 删除重复文档
Remove-Item docs/vps-deployment.md, docs/deployment-checklist.md -Force
```

### 深度清理（准备发布）
```powershell
# 上面的快速清理 +
Remove-Item dist, node_modules -Recurse -Force

# 之后重新安装和构建
npm install
npm run build
npm test
```

---

## ⚠️ 注意事项

### 不要删除
- `src/` - 源代码
- `test/` - 测试代码
- `docs/` - 文档
- `config/` - 配置
- `scripts/` - 脚本
- `.env` - 你的配置
- `package.json` - 项目定义

### 可以安全删除
- `output/` - 测试输出
- `tmp/` - 临时文件
- `test-results/` - 测试缓存
- `参考图/` - 参考图片
- `dist/` - 可重新构建
- `node_modules/` - 可重新安装

### 建议保留（但移到 config/）
- `exa_api_key.txt` → `config/exa_api_key.txt.old`

---

## 🚀 清理后的下一步

```powershell
# 1. 验证项目仍然正常
npm test

# 2. 重新构建
npm run build

# 3. 提交到 Git
git add .
git commit -m "Project refactoring: organized structure"

# 4. 发布到 Docker Hub
cd scripts
.\publish-docker-hub.bat
```

---

需要我现在帮你执行清理吗？
