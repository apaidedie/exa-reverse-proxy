import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFakeExa } from './helpers/fakeExa.js';
import { testConfig } from './testConfig.js';

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
});

describe('admin key CRUD', () => {
  it('creates a new key via POST /_proxy/keys', async () => {
    const fake = await createFakeExa(() => ({ status: 200, body: { ok: true } }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url }) });
    apps.push(app);

    const create = await app.inject({
      method: 'POST',
      url: '/_proxy/keys',
      headers: {
        authorization: 'Bearer admin_token',
        'content-type': 'application/json'
      },
      payload: { id: 'new_key', value: 'new-api-key-value', weight: 2 }
    });

    expect(create.statusCode).toBe(200);
    expect(create.json()).toMatchObject({ ok: true, id: 'new_key', weight: 2, enabled: true });

    const keys = await app.inject({ method: 'GET', url: '/_proxy/keys', headers: { authorization: 'Bearer admin_token' } });
    const keyIds = keys.json().keys.map((k: { id: string }) => k.id);
    expect(keyIds).toContain('new_key');
  });

  it('rejects duplicate key id', async () => {
    const fake = await createFakeExa(() => ({ status: 200, body: { ok: true } }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url }) });
    apps.push(app);

    const dup = await app.inject({
      method: 'POST',
      url: '/_proxy/keys',
      headers: {
        authorization: 'Bearer admin_token',
        'content-type': 'application/json'
      },
      payload: { id: 'a', value: 'duplicate-key-value' }
    });

    expect(dup.statusCode).toBe(409);
  });

  it('updates key weight via PUT /_proxy/keys/:id', async () => {
    const fake = await createFakeExa(() => ({ status: 200, body: { ok: true } }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url }) });
    apps.push(app);

    const update = await app.inject({
      method: 'PUT',
      url: '/_proxy/keys/a',
      headers: {
        authorization: 'Bearer admin_token',
        'content-type': 'application/json'
      },
      payload: { weight: 5 }
    });

    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ ok: true, id: 'a' });
  });

  it('updates key value via PUT /_proxy/keys/:id', async () => {
    const fake = await createFakeExa(() => ({ status: 200, body: { ok: true } }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url, allowRawKeyDisplay: true }) });
    apps.push(app);

    const update = await app.inject({
      method: 'PUT',
      url: '/_proxy/keys/a',
      headers: {
        authorization: 'Bearer admin_token',
        'content-type': 'application/json'
      },
      payload: { value: 'updated-key-value' }
    });

    expect(update.statusCode).toBe(200);

    const secret = await app.inject({
      method: 'POST',
      url: '/_proxy/keys/a/secret',
      headers: { authorization: 'Bearer admin_token' }
    });
    expect(secret.json().secret).toBe('updated-key-value');
  });

  it('deletes a key via DELETE /_proxy/keys/:id', async () => {
    const fake = await createFakeExa(() => ({ status: 200, body: { ok: true } }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url }) });
    apps.push(app);

    const del = await app.inject({
      method: 'DELETE',
      url: '/_proxy/keys/a',
      headers: { authorization: 'Bearer admin_token' }
    });

    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, id: 'a' });

    const keys = await app.inject({ method: 'GET', url: '/_proxy/keys', headers: { authorization: 'Bearer admin_token' } });
    const keyIds = keys.json().keys.map((k: { id: string }) => k.id);
    expect(keyIds).not.toContain('a');
    expect(keyIds).toContain('b');
  });

  it('refuses to delete the last remaining key', async () => {
    const fake = await createFakeExa(() => ({ status: 200, body: { ok: true } }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url, keys: [{ id: 'only', value: 'only-key', weight: 1, enabled: true }] }) });
    apps.push(app);

    const del = await app.inject({
      method: 'DELETE',
      url: '/_proxy/keys/only',
      headers: { authorization: 'Bearer admin_token' }
    });

    expect(del.statusCode).toBe(409);
  });

  it('returns 404 when updating or deleting a non-existent key', async () => {
    const fake = await createFakeExa(() => ({ status: 200, body: { ok: true } }));
    apps.push(fake.app);
    const app = await buildApp({ config: testConfig({ upstreamUrl: fake.url }) });
    apps.push(app);

    const update = await app.inject({
      method: 'PUT',
      url: '/_proxy/keys/nonexistent',
      headers: {
        authorization: 'Bearer admin_token',
        'content-type': 'application/json'
      },
      payload: { weight: 3 }
    });
    expect(update.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: '/_proxy/keys/nonexistent',
      headers: { authorization: 'Bearer admin_token' }
    });
    expect(del.statusCode).toBe(404);
  });

  it('uses a dynamically added key for proxy requests', async () => {
    const seenKeys: string[] = [];
    const fake = await createFakeExa((request) => {
      seenKeys.push(request.headers['x-api-key'] ?? '');
      return { status: 200, body: { ok: true, key: request.headers['x-api-key'] } };
    });
    apps.push(fake.app);
    const app = await buildApp({
      config: testConfig({
        upstreamUrl: fake.url,
        keys: [{ id: 'initial', value: 'initial-key', weight: 1, enabled: true }],
        maxAttempts: 1,
        selectionStrategy: 'round_robin'
      })
    });
    apps.push(app);

    // Add a new key
    await app.inject({
      method: 'POST',
      url: '/_proxy/keys',
      headers: {
        authorization: 'Bearer admin_token',
        'content-type': 'application/json'
      },
      payload: { id: 'added', value: 'added-key-value', weight: 1 }
    });

    // Send enough requests to hit both keys
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/search',
        headers: { authorization: 'Bearer client_token', 'content-type': 'application/json' },
        payload: { query: 'test' }
      });
      results.push(res.json().key);
    }

    expect(seenKeys).toContain('initial-key');
    expect(seenKeys).toContain('added-key-value');
  });
});
