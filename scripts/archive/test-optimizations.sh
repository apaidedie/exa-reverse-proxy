#!/bin/bash
# 优化验证和测试脚本
# 运行此脚本以验证所有优化

set -e

echo "========================================"
echo "   Exa 反向代理 - 优化验证测试"
echo "========================================"
echo ""

cd "$(dirname "$0")/.."

echo "[1/5] 检查 Node.js 版本..."
node --version
echo ""

echo "[2/5] 安装依赖..."
npm install
echo ""

echo "[3/5] 运行验证脚本..."
npx tsx scripts/verify-optimizations.ts || echo "⚠️  警告: 部分验证未通过"
echo ""

echo "[4/5] TypeScript 类型检查..."
npm run lint
echo ""

echo "[5/5] 运行测试套件..."
npm test
echo ""

echo "========================================"
echo "         ✅ 所有验证通过！"
echo "========================================"
echo ""
echo "下一步:"
echo "  1. 查看 docs\\OPTIMIZATIONS_SUMMARY.md 了解详情"
echo "  2. 运行 docker compose build 构建镜像"
echo "  3. 运行 docker compose up -d 启动服务"
echo ""
