import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createStateStore } from '../src/state.js';
import { testConfig } from './testConfig.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFakeExa } from './helpers/fakeExa.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('app', () => {
  it('returns service health', async () => {
    const app = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        upstreamUrl: 'https://api.exa.ai',
        keys: [],
        proxyTokens: ['client_token'],
        adminTokens: ['admin_token'],
        statePath: ':memory:',
        selectionStrategy: 'weighted_round_robin',
        maxAttempts: 3,
        attemptTimeoutMs: 30000,
        retryBackoffMs: [200, 600, 1500],
        failureThreshold: 3,
        failureWindowSeconds: 60,
        cooldownSeconds: 120,
        rateLimitCooldownSeconds: 300,
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
        affinityRetentionDays: 7,
      }
    });

    const response = await app.inject({
      method: 'GET',
      url: '/_proxy/health',
      headers: { authorization: 'Bearer admin_token' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it('automatically prunes request logs older than the retention window on startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exa-auto-retention-'));
    const dbPath = join(dir, 'state.sqlite');
    const keys = [{ id: 'a', value: 'key-a', weight: 1, enabled: true }];

    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-09T00:00:00Z'));
      const seed = createStateStore(dbPath, keys);
      seed.recordRequestLog({ requestId: 'old', tokenId: 'tok_old', method: 'GET', path: '/search', status: 200, keyIds: ['a'], attempts: 1, latencyMs: 8, errorCode: null });
      vi.setSystemTime(new Date('2026-06-10T23:30:00Z'));
      seed.recordRequestLog({ requestId: 'recent', tokenId: 'tok_recent', method: 'GET', path: '/search', status: 200, keyIds: ['a'], attempts: 1, latencyMs: 9, errorCode: null });
      seed.close();

      vi.setSystemTime(new Date('2026-06-11T00:00:00Z'));
      const app = await buildApp({ config: testConfig({ statePath: dbPath, keys, logRetentionDays: 1 }) });

      try {
        const logs = await app.inject({ method: 'GET', url: '/_proxy/logs?limit=10', headers: { authorization: 'Bearer admin_token' } });
        const audit = await app.inject({ method: 'GET', url: '/_proxy/audit', headers: { authorization: 'Bearer admin_token' } });
        const requestIds = logs.json().logs.map((log: any) => log.requestId);

        expect(logs.statusCode).toBe(200);
        expect(requestIds).toContain('recent');
        expect(requestIds).not.toContain('old');
        expect(audit.json().audit.some((item: any) => item.action === 'auto_prune_logs')).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('periodically prunes request logs while the service keeps running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T00:00:00Z'));
    const app = await buildApp({ config: testConfig({ logRetentionDays: 1 }) });

    try {
      await app.inject({ method: 'GET', url: '/search', headers: { authorization: 'Bearer wrong' } });
      const before = await app.inject({ method: 'GET', url: '/_proxy/logs?limit=10', headers: { authorization: 'Bearer admin_token' } });

      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
      const after = await app.inject({ method: 'GET', url: '/_proxy/logs?limit=10', headers: { authorization: 'Bearer admin_token' } });
      const audit = await app.inject({ method: 'GET', url: '/_proxy/audit', headers: { authorization: 'Bearer admin_token' } });

      expect(before.json().logs.length).toBeGreaterThan(0);
      expect(after.json().logs).toHaveLength(0);
      expect(audit.json().audit.some((item: any) => item.action === 'auto_prune_logs')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('hydrates persisted key disablement on restart before routing traffic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exa-scheduler-hydrate-'));
    const dbPath = join(dir, 'state.sqlite');
    const seenKeys: string[] = [];
    const fake = await createFakeExa((request) => {
      seenKeys.push(request.headers['x-api-key'] ?? '');
      return { status: 200, body: { ok: true, key: request.headers['x-api-key'] } };
    });
    const keys = [
      { id: 'a', value: 'key-a', weight: 1, enabled: true },
      { id: 'b', value: 'key-b', weight: 1, enabled: true }
    ];

    try {
      const first = await buildApp({ config: testConfig({ statePath: dbPath, upstreamUrl: fake.url, keys }) });
      await first.inject({ method: 'POST', url: '/_proxy/keys/a/disable', headers: { authorization: 'Bearer admin_token' } });
      await first.close();

      const restarted = await buildApp({ config: testConfig({ statePath: dbPath, upstreamUrl: fake.url, keys }) });
      try {
        const response = await restarted.inject({ method: 'GET', url: '/search', headers: { authorization: 'Bearer client_token' } });
        const keyStats = await restarted.inject({ method: 'GET', url: '/_proxy/keys', headers: { authorization: 'Bearer admin_token' } });

        expect(response.statusCode).toBe(200);
        expect(seenKeys).toEqual(['key-b']);
        expect(keyStats.json().keys.find((key: any) => key.id === 'a')).toMatchObject({ enabled: false });
      } finally {
        await restarted.close();
      }
    } finally {
      await fake.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
