import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFakeExa } from './helpers/fakeExa.js';
import { testConfig } from './testConfig.js';

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
});

describe('proxy failover', () => {
  it('passes through requests, hides client auth, and injects selected upstream key', async () => {
    const fake = await createFakeExa((request) => ({
      body: { used: request.headers['x-api-key'], auth: request.headers.authorization, path: request.url, body: request.body }
    }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url, maxAttempts: 1 }) });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/search?source=test',
      headers: { authorization: 'Bearer client_token', 'content-type': 'application/json' },
      payload: { query: 'hello' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ used: 'key-a', path: '/search?source=test', body: { query: 'hello' } });
  });

  it('retries a 429 with another key and records admin stats and sanitized logs', async () => {
    const seenKeys: string[] = [];
    const fake = await createFakeExa((request) => {
      seenKeys.push(request.headers['x-api-key'] ?? '');
      if (seenKeys.length === 1) return { status: 429, body: { error: 'rate limited' } };
      return { status: 200, body: { ok: true, key: request.headers['x-api-key'] } };
    });
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url, rateLimitCooldownSeconds: 1 }) });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/search',
      headers: { authorization: 'Bearer client_token', 'content-type': 'application/json' },
      payload: { query: 'hello' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, key: 'key-b' });
    expect(seenKeys).toEqual(['key-a', 'key-b']);

    const keys = await app.inject({ method: 'GET', url: '/_proxy/keys', headers: { authorization: 'Bearer admin_token' } });
    expect(keys.body).toContain('"id":"a"');
    expect(keys.body).toContain('"displayId":"a"');
    expect(keys.body).not.toContain('"value"');
    expect(keys.body).not.toContain('key-a');

    const logs = await app.inject({ method: 'GET', url: '/_proxy/logs', headers: { authorization: 'Bearer admin_token' } });
    expect(logs.json().logs[0]).toMatchObject({ path: '/search', status: 200, attempts: 2, keyIds: ['a', 'b'] });
    expect(logs.body).not.toContain('key-a');
  });

  it('records exhausted 429 failover with the upstream status and rate-limit reason', async () => {
    const fake = await createFakeExa(() => ({ status: 429, body: { error: 'rate limited' } }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url, maxAttempts: 3, rateLimitCooldownSeconds: 1 }) });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/search',
      headers: { authorization: 'Bearer client_token', 'content-type': 'application/json' },
      payload: { query: 'hello' }
    });

    expect(response.statusCode).toBe(429);

    const logs = await app.inject({ method: 'GET', url: '/_proxy/logs', headers: { authorization: 'Bearer admin_token' } });
    expect(logs.json().logs[0]).toMatchObject({ path: '/search', status: 429, attempts: 2, keyIds: ['a', 'b'], errorCode: 'rate_limit' });
  });

  it('disables a key on 402 and fails over to the next key', async () => {
    const seenKeys: string[] = [];
    const fake = await createFakeExa((request) => {
      seenKeys.push(request.headers['x-api-key'] ?? '');
      if (seenKeys.length === 1) return { status: 402, body: { error: 'credits exhausted' } };
      return { status: 200, body: { ok: true, key: request.headers['x-api-key'] } };
    });
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url }) });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/search',
      headers: { authorization: 'Bearer client_token', 'content-type': 'application/json' },
      payload: { query: 'hello' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, key: 'key-b' });
    expect(seenKeys).toEqual(['key-a', 'key-b']);

    const keys = await app.inject({ method: 'GET', url: '/_proxy/keys', headers: { authorization: 'Bearer admin_token' } });
    const keyA = keys.json().keys.find((k: { id: string }) => k.id === 'a');
    expect(keyA).toMatchObject({ id: 'a', enabled: false, lastError: 'credits_exhausted', creditsExhaustedCount: 1 });
  });

  it('counts non-retryable upstream client errors as failed requests', async () => {
    const fake = await createFakeExa(() => ({ status: 400, body: { error: 'bad request' } }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url, maxAttempts: 3 }) });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/search',
      headers: { authorization: 'Bearer client_token', 'content-type': 'application/json' },
      payload: { query: '' }
    });

    expect(response.statusCode).toBe(400);

    const keys = await app.inject({ method: 'GET', url: '/_proxy/keys', headers: { authorization: 'Bearer admin_token' } });
    expect(keys.json().keys[0]).toMatchObject({ id: 'a', totalRequests: 1, successCount: 0, failureCount: 1, lastError: 'client_status' });

    const logs = await app.inject({ method: 'GET', url: '/_proxy/logs', headers: { authorization: 'Bearer admin_token' } });
    expect(logs.json().logs[0]).toMatchObject({ path: '/search', status: 400, attempts: 1, keyIds: ['a'], errorCode: 'client_status' });
  });

  it('starts with zero keys and returns 503 for proxy requests', async () => {
    const app = await buildApp({ config: testConfig({ keys: [] }) });
    const res = await app.inject({ method: 'POST', path: '/search', headers: { authorization: 'Bearer client_token' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'no_healthy_keys' } });
    await app.close();
  });
});
