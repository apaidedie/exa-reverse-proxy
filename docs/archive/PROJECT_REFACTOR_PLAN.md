# 项目结构规范化方案

## 📁 当前存在的问题

1. **API Key 存储不规范** - 使用 `.txt` 文件
2. **文档文件混乱** - 太多临时文档文件散落在根目录
3. **配置文件缺乏组织** - `.env` 和示例文件没有清晰的结构
4. **缺少规范的目录结构** - 脚本、文档、配置混在一起

---

## 🎯 规范化后的项目结构

```
exa-reverse-proxy/
├── .env                          # 主配置文件（不提交到 git）
├── .env.example                  # 配置模板
├── .gitignore                    # Git 忽略规则
├── package.json                  # 项目依赖
├── tsconfig.json                 # TypeScript 配置
├── docker-compose.yml            # 本地开发用
├── Dockerfile                    # 镜像构建
├── README.md                     # 项目说明
│
├── docs/                         # 📚 文档目录
│   ├── OPTIMIZATIONS.md          # 优化说明
│   ├── DEPLOYMENT.md             # 部署指南
│   ├── API.md                    # API 文档
│   ├── CHANGELOG.md              # 变更日志
│   └── UI_GUIDE.md               # UI 使用指南
│
├── config/                       # ⚙️  配置目录
│   ├── secrets.example.json      # Secret 示例（JSON 格式）
│   ├── docker-compose.vps.yml    # VPS 部署配置
│   └── nginx.conf.example        # Nginx 配置示例
│
├── scripts/                      # 🔧 脚本目录
│   ├── publish-docker.sh         # Docker Hub 发布
│   ├── setup-dev.sh              # 开发环境设置
│   ├── backup.sh                 # 数据备份
│   └── verify-optimizations.ts   # 验证脚本
│
├── src/                          # 💻 源代码
│   ├── index.ts
│   ├── config.ts
│   ├── proxy.ts
│   └── ...
│
├── test/                         # 🧪 测试代码
│   └── *.test.ts
│
└── dist/                         # 📦 编译输出（不提交）
```

---

## 🔑 改进 API Key 存储方式

### 方案 1: JSON 格式（推荐）

**config/secrets.json**
```json
{
  "exaKeys": [
    {
      "id": "exa_prod_1",
      "key": "your-exa-api-key-1",
      "weight": 2,
      "enabled": true
    },
    {
      "id": "exa_prod_2",
      "key": "your-exa-api-key-2",
      "weight": 1,
      "enabled": true
    }
  ],
  "proxyTokens": [
    "client-token-prod-16-chars-min"
  ],
  "adminTokens": [
    "admin-token-prod-16-chars-min"
  ]
}
```

**优点:**
- ✅ 结构化，易于解析
- ✅ 支持注释和元数据
- ✅ 可以添加 `enabled` 标志
- ✅ IDE 支持自动补全

### 方案 2: YAML 格式（更人性化）

**config/secrets.yml**
```yaml
exaKeys:
  - id: exa_prod_1
    key: your-exa-api-key-1
    weight: 2
    enabled: true
    note: "主要生产 Key"

  - id: exa_prod_2
    key: your-exa-api-key-2
    weight: 1
    enabled: true
    note: "备用 Key"

proxyTokens:
  - client-token-prod-16-chars-min

adminTokens:
  - admin-token-prod-16-chars-min
```

**优点:**
- ✅ 更易读
- ✅ 支持注释
- ✅ 层次清晰

### 方案 3: 环境变量 + Docker Secrets（生产推荐）

**.env**
```env
# 使用 Docker Secrets
EXA_KEYS_SECRET=/run/secrets/exa_keys
PROXY_TOKENS_SECRET=/run/secrets/proxy_tokens
ADMIN_TOKENS_SECRET=/run/secrets/admin_tokens
```

**docker-compose.yml**
```yaml
services:
  exa-proxy:
    secrets:
      - exa_keys
      - proxy_tokens
      - admin_tokens

secrets:
  exa_keys:
    file: ./config/secrets/exa_keys.json
  proxy_tokens:
    file: ./config/secrets/proxy_tokens.txt
  admin_tokens:
    file: ./config/secrets/admin_tokens.txt
```

---

## 📋 实施步骤

### Step 1: 创建目录结构
```bash
mkdir -p docs config scripts
```

### Step 2: 移动文件到对应目录

**移动文档:**
```bash
mv OPTIMIZATIONS_SUMMARY.md docs/
mv FINAL_REPORT.md docs/
mv DOCKER_HUB_GUIDE.md docs/DEPLOYMENT.md
mv NEW_UI_README.md docs/UI_GUIDE.md
```

**移动配置:**
```bash
mv docker-compose.vps.yml config/
mv .env.example config/
```

**移动脚本:**
```bash
mv publish-docker-hub.bat scripts/
mv apply-modern-ui.bat scripts/
mv prepare-deployment.bat scripts/
mv verify-optimizations.ts scripts/
```

### Step 3: 创建 secrets 配置模板

**config/secrets.example.json**
```json
{
  "$schema": "./secrets.schema.json",
  "exaKeys": [
    {
      "id": "exa_key_1",
      "key": "your-exa-api-key-here",
      "weight": 1,
      "enabled": true
    }
  ],
  "proxyTokens": [
    "replace-with-16-char-min-token"
  ],
  "adminTokens": [
    "replace-with-16-char-min-token"
  ]
}
```

### Step 4: 更新 .gitignore
```gitignore
# Secrets
config/secrets.json
config/secrets.yml
config/secrets/
*.key
*.pem

# Environment
.env
.env.local
.env.*.local

# Build
dist/
node_modules/

# Database
*.sqlite
*.sqlite-*

# Logs
logs/
*.log

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
```

---

## 🔄 代码修改

### 修改 `src/config.ts` 支持 JSON 配置

```typescript
// 新增：从 JSON 文件加载 secrets
function loadSecretsFromJson(path: string): {
  exaKeys: Array<{id: string; key: string; weight: number}>;
  proxyTokens: string[];
  adminTokens: string[];
} {
  const content = readFileSync(path, 'utf-8');
  const secrets = JSON.parse(content);

  return {
    exaKeys: secrets.exaKeys
      .filter((k: any) => k.enabled !== false)
      .map((k: any) => ({
        id: k.id,
        key: k.key,
        weight: k.weight || 1
      })),
    proxyTokens: secrets.proxyTokens,
    adminTokens: secrets.adminTokens
  };
}

// 在 loadConfigFromEnv 中使用
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // 优先使用 JSON 配置
  if (env.EXA_SECRETS_JSON) {
    const secrets = loadSecretsFromJson(env.EXA_SECRETS_JSON);
    // 使用 secrets 中的值...
  }

  // 否则使用原有的环境变量方式
  // ...
}
```

---

## 🎯 最终效果

### 开发环境
```bash
# 1. 复制配置模板
cp config/secrets.example.json config/secrets.json

# 2. 编辑配置
nano config/secrets.json

# 3. 设置环境变量
export EXA_SECRETS_JSON=./config/secrets.json

# 4. 启动
npm start
```

### 生产环境
```bash
# 使用 Docker Secrets
docker secret create exa_keys config/secrets.json
docker service create \
  --secret exa_keys \
  your-image
```

---

## ✅ 规范化的好处

1. **更清晰的结构** - 文档、配置、脚本分离
2. **更安全的 Secret 管理** - JSON/YAML 格式，支持加密
3. **更易于维护** - 每个文件职责明确
4. **更专业的项目** - 符合业界最佳实践
5. **更好的协作** - 新成员快速上手

---

需要我现在帮你执行这个规范化方案吗？
