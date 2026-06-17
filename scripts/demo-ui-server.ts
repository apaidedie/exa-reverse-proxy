import Fastify from 'fastify';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import type { ProxyConfig } from '../src/app.js';

const demoDir = resolve(process.cwd(), 'tmp');
mkdirSync(demoDir, { recursive: true });
const statePath = resolve(demoDir, 'exa-proxy-demo.sqlite');
for (const suffix of ['', '-shm', '-wal']) rmSync(`${statePath}${suffix}`, { force: true });

const fake = Fastify({ logger: false });
fake.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
fake.all('/*', async (request, reply) => {
  const key = String(request.headers['x-api-key'] || '');
  const url = request.url;

  if (url.includes('limited')) {
    return reply.code(429).header('retry-after', '1800').send({ error: 'rate_limited', key });
  }

  if (url.includes('slow')) {
    await new Promise((resolveSlow) => setTimeout(resolveSlow, 220));
    return reply.send({ ok: true, slow: true, key });
  }

  if (url.includes('spike')) {
    return reply.code(503).send({ error: 'temporary_upstream_spike', key });
  }

  return reply.send({ ok: true, path: url, key, ts: Date.now() });
});
await fake.listen({ host: '127.0.0.1', port: 0 });
const address = fake.server.address();
if (!address || typeof address === 'string') throw new Error('fake upstream failed');
const upstreamUrl = `http://127.0.0.1:${address.port}`;

const config: ProxyConfig = {
  host: '127.0.0.1',
  port: 8787,
  upstreamUrl,
  keys: [
    { id: 'key_01_search', value: 'fake_key_01', weight: 1, enabled: true },
    { id: 'key_02_contents', value: 'fake_key_02', weight: 1, enabled: true },
    { id: 'key_03_research', value: 'fake_key_03', weight: 1, enabled: true },
    { id: 'key_04_agent', value: 'fake_key_04', weight: 1, enabled: true },
    { id: 'key_05_archive', value: 'fake_key_05', weight: 1, enabled: true },
    { id: 'key_06_backup', value: 'fake_key_06', weight: 1, enabled: true }
  ],
  proxyTokens: ['client_local_token'],
  adminTokens: ['admin_local_token'],
  statePath,
  selectionStrategy: 'round_robin',
  maxAttempts: 3,
  attemptTimeoutMs: 80,
  retryBackoffMs: [1, 1, 1],
  failureThreshold: 3,
  failureWindowSeconds: 60,
  cooldownSeconds: 300,
  rateLimitCooldownSeconds: 1800,
  creditsExhaustedCooldownSeconds: 600,
  maxBodyBytes: 20971520,
  allowedPaths: ['/**'],
  resourceAffinity: true,
  logLevel: 'silent',
  adminSessionTtlSeconds: 604800,
  adminLockoutMaxFailures: 5,
  adminLockoutWindowSeconds: 300,
  adminLockoutSeconds: 900,
  adminRequireHttps: false,
  allowRawKeyDisplay: false,
  logRetentionDays: 14,
  alertAvailableKeyMin: 1,
  alertFailureRatePercent: 10,
  alertRateLimitRatePercent: 20,
  alertWebhookUrl: null,
  alertWebhookBearerToken: null,
  alertWebhookCooldownSeconds: 300,
  alertWebhookHmacSecret: null,
  alertWebhookMaxAttempts: 1,
  alertWebhookRetryBackoffMs: 250,
  trendWindowHours: 24,
  trustProxy: false,
  upstreamPoolConnections: 128,
  affinityRetentionDays: 7
};

const app = await buildApp({ config });
await app.listen({ host: config.host, port: config.port });

const authHeaders = { authorization: 'Bearer client_local_token', 'content-type': 'application/json' };
const adminHeaders = { authorization: 'Bearer admin_local_token' };
const send = async (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => {
  await app.inject({ method, url, headers: authHeaders, payload: method === 'POST' ? payload : undefined });
};

await send('POST', '/search?case=limited', { query: '触发一把搜索密钥限流，并制造冷却状态' });
await send('POST', '/search?case=slow', { query: '触发一次上游超时并重试' });
await send('POST', '/contents?case=spike', { urls: ['https://example.com'], text: true });
await send('POST', '/contents?case=warmup', { urls: ['https://exa.ai'], text: true });
await send('POST', '/answer', { query: '检查代理健康状态' });
await send('GET', '/research/v1/demo-run');

for (let i = 0; i < 18; i += 1) {
  const route = i % 3 === 0 ? '/search' : i % 3 === 1 ? '/contents' : '/answer';
  const method = i % 5 === 0 ? 'GET' : 'POST';
  await send(method, `${route}?batch=${i}`, method === 'POST' ? { query: `demo-${i}`, urls: ['https://exa.ai'] } : undefined);
}

await app.inject({ method: 'POST', url: '/_proxy/keys/key_05_archive/disable', headers: adminHeaders });
await app.inject({ method: 'POST', url: '/_proxy/keys/key_04_agent/reset-circuit', headers: adminHeaders });
await send('POST', '/search?case=slow&recent=1', { query: '最近一次超时样本' });

console.log('演示控制台已启动');
console.log('地址: http://127.0.0.1:8787');
console.log('管理员令牌: admin_local_token');
console.log('客户端令牌: client_local_token');
console.log(`模拟上游: ${upstreamUrl}`);

async function close() {
  await app.close();
  await fake.close();
}
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
