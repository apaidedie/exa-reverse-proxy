#!/usr/bin/env tsx
/**
 * Verification script for optimizations
 * Run with: npx tsx scripts/verify-optimizations.ts
 */

import { readFileSync } from 'node:fs';

console.log('🔍 验证优化变更...\n');

const checks: { name: string; passed: boolean; message: string }[] = [];

// 1. 检查 auth.ts 是否使用了 HMAC
try {
  const authContent = readFileSync('src/auth.ts', 'utf-8');
  const usesHmac = authContent.includes('createHmac') && authContent.includes('exa-proxy-v1');
  checks.push({
    name: 'Token 安全性 (HMAC)',
    passed: usesHmac,
    message: usesHmac ? '✓ 使用 HMAC 加盐哈希' : '✗ 未使用 HMAC'
  });
} catch {
  checks.push({
    name: 'Token 安全性 (HMAC)',
    passed: false,
    message: '✗ 无法读取 auth.ts'
  });
}

// 2. 检查 state.ts 是否添加了新索引
try {
  const stateContent = readFileSync('src/state.ts', 'utf-8');
  const hasNewIndexes =
    stateContent.includes('request_logs_status_idx') &&
    stateContent.includes('request_logs_path_idx') &&
    stateContent.includes('admin_audit_logs_action_idx');
  checks.push({
    name: '数据库索引',
    passed: hasNewIndexes,
    message: hasNewIndexes ? '✓ 添加了新的索引' : '✗ 缺少新索引'
  });
} catch {
  checks.push({
    name: '数据库索引',
    passed: false,
    message: '✗ 无法读取 state.ts'
  });
}

// 3. 检查 scheduler.ts 是否添加了缓存
try {
  const schedulerContent = readFileSync('src/scheduler.ts', 'utf-8');
  const hasCache =
    schedulerContent.includes('adaptiveSeqCache') &&
    schedulerContent.includes('CACHE_TTL');
  checks.push({
    name: '调度器缓存',
    passed: hasCache,
    message: hasCache ? '✓ 添加了自适应序列缓存' : '✗ 缺少缓存机制'
  });
} catch {
  checks.push({
    name: '调度器缓存',
    passed: false,
    message: '✗ 无法读取 scheduler.ts'
  });
}

// 4. 检查 scheduler.ts 是否有内存泄漏防护
try {
  const schedulerContent = readFileSync('src/scheduler.ts', 'utf-8');
  const hasMemoryProtection = schedulerContent.includes('.slice(-Math.max(threshold * 2, 100))');
  checks.push({
    name: '内存泄漏防护',
    passed: hasMemoryProtection,
    message: hasMemoryProtection ? '✓ 限制了 failureTimestamps 数组大小' : '✗ 缺少内存保护'
  });
} catch {
  checks.push({
    name: '内存泄漏防护',
    passed: false,
    message: '✗ 无法读取 scheduler.ts'
  });
}

// 5. 检查 config.ts 是否添加了验证
try {
  const configContent = readFileSync('src/config.ts', 'utf-8');
  const hasValidation =
    configContent.includes('keys.length === 0') &&
    configContent.includes('at least 16 characters');
  checks.push({
    name: '配置验证',
    passed: hasValidation,
    message: hasValidation ? '✓ 添加了配置验证逻辑' : '✗ 缺少验证'
  });
} catch {
  checks.push({
    name: '配置验证',
    passed: false,
    message: '✗ 无法读取 config.ts'
  });
}

// 6. 检查 proxy.ts 是否添加了 try-finally
try {
  const proxyContent = readFileSync('src/proxy.ts', 'utf-8');
  const hasTryFinally = proxyContent.includes('try {') && proxyContent.includes('} finally {');
  checks.push({
    name: '错误处理改进',
    passed: hasTryFinally,
    message: hasTryFinally ? '✓ 添加了 try-finally 保护' : '✗ 缺少 try-finally'
  });
} catch {
  checks.push({
    name: '错误处理改进',
    passed: false,
    message: '✗ 无法读取 proxy.ts'
  });
}

// 7. 检查 admin.ts 是否添加了速率限制
try {
  const adminContent = readFileSync('src/admin.ts', 'utf-8');
  const hasRateLimit = adminContent.includes('@fastify/rate-limit') && adminContent.includes('rateLimit');
  checks.push({
    name: '速率限制',
    passed: hasRateLimit,
    message: hasRateLimit ? '✓ 添加了速率限制保护' : '✗ 缺少速率限制'
  });
} catch {
  checks.push({
    name: '速率限制',
    passed: false,
    message: '✗ 无法读取 admin.ts'
  });
}

// 8. 检查 package.json 是否添加了依赖
try {
  const packageContent = readFileSync('package.json', 'utf-8');
  const hasRateLimitDep = packageContent.includes('@fastify/rate-limit');
  checks.push({
    name: 'package.json 依赖',
    passed: hasRateLimitDep,
    message: hasRateLimitDep ? '✓ 添加了 @fastify/rate-limit' : '✗ 缺少依赖'
  });
} catch {
  checks.push({
    name: 'package.json 依赖',
    passed: false,
    message: '✗ 无法读取 package.json'
  });
}

// 9. 检查 Dockerfile 优化
try {
  const dockerfileContent = readFileSync('Dockerfile', 'utf-8');
  const hasSetE = dockerfileContent.includes('set -e');
  const hasCaCerts = dockerfileContent.includes('ca-certificates');
  checks.push({
    name: 'Dockerfile 优化',
    passed: hasSetE && hasCaCerts,
    message: hasSetE && hasCaCerts ? '✓ 优化了构建流程' : '✗ 缺少优化'
  });
} catch {
  checks.push({
    name: 'Dockerfile 优化',
    passed: false,
    message: '✗ 无法读取 Dockerfile'
  });
}

// 输出结果
console.log('验证结果:\n');
checks.forEach(check => {
  console.log(`${check.passed ? '✅' : '❌'} ${check.name}`);
  console.log(`   ${check.message}\n`);
});

const passedCount = checks.filter(c => c.passed).length;
const totalCount = checks.length;
const percentage = Math.round((passedCount / totalCount) * 100);

console.log(`\n总结: ${passedCount}/${totalCount} 项检查通过 (${percentage}%)`);

if (passedCount === totalCount) {
  console.log('\n🎉 所有优化已正确应用！');
  process.exit(0);
} else {
  console.log('\n⚠️  部分优化可能未正确应用，请检查上述失败项。');
  process.exit(1);
}
