import type { FastifyInstance } from 'fastify';
import { proxyError, requestIdFrom } from '../errors.js';
import { classifyError, classifyStatus, parseRetryAfterMs } from '../retry.js';
import { callUpstream, type UpstreamResponse } from '../upstream.js';
import type { AppDeps, KeyConfig } from '../app.js';
import type { AdminAuthContext } from './auth.js';
import { parseJsonBody } from './auth.js';
import { encrypt } from '../crypto.js';

type KeyTestResult = { ok: boolean; id: string; status: number; latencyMs: number; reason: string };

async function consumeBody(response: UpstreamResponse): Promise<void> {
  for await (const _chunk of response.body) {
    // Drain the upstream response so the connection can be reused.
  }
}

export function adminKeyStats(deps: AppDeps): Array<Record<string, unknown>> {
  return deps.state.listKeyStats().map((key) => {
    const keyConfig = deps.scheduler.getKey(key.id);
    return {
      ...key,
      value: undefined,
      displayId: deps.config.allowRawKeyDisplay ? (keyConfig?.value ?? key.id) : key.id,
      rawKeyDisplayAllowed: deps.config.allowRawKeyDisplay
    };
  });
}

function recordAttempt(deps: AppDeps, record: Parameters<AppDeps['state']['recordAttempt']>[0]): void {
  deps.state.recordAttempt(record);
  deps.scheduler.updateAdaptiveStats(deps.state.listKeyStats());
}

export async function testConfiguredKey(deps: AppDeps, key: KeyConfig, requestId: string): Promise<KeyTestResult> {
  const start = Date.now();
  try {
    const upstream = await callUpstream({
      baseUrl: deps.config.upstreamUrl,
      pathAndQuery: '/search',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key.value,
        'x-request-id': requestId
      },
      body: Buffer.from(JSON.stringify({ query: 'Exa key health check', numResults: 1 })),
      timeoutMs: Math.min(deps.config.attemptTimeoutMs, 10000)
    });

    const latencyMs = Date.now() - start;
    const decision = classifyStatus(upstream.statusCode);
    const success = upstream.statusCode >= 200 && upstream.statusCode < 400;
    recordAttempt(deps, { keyId: key.id, status: upstream.statusCode, success, latencyMs, retry: false, reason: decision.reason });

    if (decision.reason === 'rate_limit') {
      const retryAfter = Array.isArray(upstream.headers['retry-after']) ? upstream.headers['retry-after'][0] : upstream.headers['retry-after'];
      const until = Date.now() + (parseRetryAfterMs(retryAfter) ?? deps.config.rateLimitCooldownSeconds * 1000);
      deps.scheduler.coolDown(key.id, until, Date.now(), 'rate_limit');
      deps.state.setCooldown(key.id, until, 'rate_limit');
    } else if (decision.reason === 'credits_exhausted') {
      // Disable the key entirely — 402 means credits are exhausted and won't recover automatically.
      deps.scheduler.setDisabled(key.id, true);
      deps.state.setEnabled(key.id, false);
    } else if (decision.retryable) {
      const until = deps.scheduler.recordFailure(key.id, Date.now(), deps.config.failureThreshold, deps.config.failureWindowSeconds * 1000, deps.config.cooldownSeconds * 1000, decision.reason);
      if (until) deps.state.setCooldown(key.id, until, decision.reason);
    } else {
      deps.scheduler.recordSuccess(key.id);
    }

    deps.state.recordRequestLog({ requestId, tokenId: null, method: 'POST', path: '/search', status: upstream.statusCode, keyIds: [key.id], attempts: 1, latencyMs, errorCode: success ? null : decision.reason });
    await consumeBody(upstream);
    return { ok: success, id: key.id, status: upstream.statusCode, latencyMs, reason: decision.reason };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const decision = classifyError(error);
    const status = decision.reason === 'timeout' ? 504 : 502;
    recordAttempt(deps, { keyId: key.id, status: null, success: false, latencyMs, retry: false, reason: decision.reason });
    const until = deps.scheduler.recordFailure(key.id, Date.now(), deps.config.failureThreshold, deps.config.failureWindowSeconds * 1000, deps.config.cooldownSeconds * 1000, decision.reason);
    if (until) deps.state.setCooldown(key.id, until, decision.reason);
    deps.state.recordRequestLog({ requestId, tokenId: null, method: 'POST', path: '/search', status, keyIds: [key.id], attempts: 1, latencyMs, errorCode: decision.reason });
    return { ok: false, id: key.id, status: 0, latencyMs, reason: decision.reason };
  }
}

export function registerKeyActionRoutes(app: FastifyInstance, deps: AppDeps, auth: AdminAuthContext): void {
  app.get('/_proxy/keys', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    return { keys: adminKeyStats(deps), scheduler: deps.scheduler.snapshot() };
  });

  app.get('/_proxy/keys/:id/failures', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const id = (request.params as { id: string }).id;
    const query = request.query as { limit?: string };
    return { summary: deps.state.keyFailureSummary(id, Number(query.limit ?? 20)) };
  });

  app.post('/_proxy/keys/batch', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const body = parseJsonBody<{ ids: string[]; action: string }>(request);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const action = String(body.action || '');
    const results: Array<Record<string, unknown>> = [];
    for (const id of ids.slice(0, action === 'test' ? 12 : 500)) {
      if (action === 'disable') {
        deps.scheduler.setDisabled(id, true);
        deps.state.setEnabled(id, false);
        results.push({ id, enabled: false });
      } else if (action === 'enable') {
        deps.scheduler.setDisabled(id, false);
        deps.state.setEnabled(id, true);
        results.push({ id, enabled: true });
      } else if (action === 'reset') {
        deps.scheduler.coolDown(id, 0, Date.now(), 'manual_reset');
        deps.state.setCooldown(id, 0, null);
        results.push({ id, reset: true });
      } else if (action === 'test') {
        const key = deps.scheduler.getKey(id);
        if (!key) {
          results.push({ id, ok: false, reason: 'key_not_found' });
        } else {
          results.push(await testConfiguredKey(deps, key, `${requestIdFrom(request.headers)}-${id}`));
        }
      }
    }
    auth.auditAdmin(request, `batch_${action || 'unknown'}`, true, null, `${results.length} keys`);
    return { ok: true, results };
  });

  app.post('/_proxy/keys/:id/disable', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const id = (request.params as { id: string }).id;
    deps.scheduler.setDisabled(id, true);
    deps.state.setEnabled(id, false);
    auth.auditAdmin(request, 'disable_key', true, id, 'Key disabled');
    return { ok: true, id, enabled: false };
  });

  app.post('/_proxy/keys/:id/enable', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const id = (request.params as { id: string }).id;
    deps.scheduler.setDisabled(id, false);
    deps.state.setEnabled(id, true);
    auth.auditAdmin(request, 'enable_key', true, id, 'Key enabled');
    return { ok: true, id, enabled: true };
  });

  app.post('/_proxy/keys/:id/test', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const id = (request.params as { id: string }).id;
    const key = deps.scheduler.getKey(id);
    const requestId = requestIdFrom(request.headers);
    if (!key) {
      auth.auditAdmin(request, 'test_key', false, id, 'Key not found');
      return reply.code(404).send(proxyError('key_not_found', 'The selected upstream key was not found.', requestId));
    }

    const result = await testConfiguredKey(deps, key, requestId);
    auth.auditAdmin(request, 'test_key', result.ok, id, `status ${result.status}, reason ${result.reason}`);
    return result;
  });

  app.post('/_proxy/keys/:id/secret', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    if (!deps.config.allowRawKeyDisplay) {
      const requestId = requestIdFrom(request.headers);
      auth.auditAdmin(request, 'reveal_key_secret', false, (request.params as { id: string }).id, 'Raw key display disabled');
      return reply.code(403).send(proxyError('raw_key_display_disabled', 'Raw key display is disabled by policy.', requestId));
    }

    const id = (request.params as { id: string }).id;
    const key = deps.scheduler.getKey(id);
    const requestId = requestIdFrom(request.headers);
    if (!key) {
      auth.auditAdmin(request, 'reveal_key_secret', false, id, 'Key not found');
      return reply.code(404).send(proxyError('key_not_found', 'The selected upstream key was not found.', requestId));
    }

    auth.auditAdmin(request, 'reveal_key_secret', true, id, 'Raw key revealed');
    return { ok: true, id, secret: key.value };
  });

  app.post('/_proxy/keys/:id/reset-circuit', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const id = (request.params as { id: string }).id;
    deps.scheduler.coolDown(id, 0, Date.now(), 'manual_reset');
    deps.state.setCooldown(id, 0, null);
    auth.auditAdmin(request, 'reset_circuit', true, id, 'Cooldown reset');
    return { ok: true, id };
  });

  app.post('/_proxy/keys', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const body = parseJsonBody<{ id: string; value: string; weight?: number }>(request);
    const requestId = requestIdFrom(request.headers);
    const id = String(body.id || '').trim();
    const value = String(body.value || '').trim();
    const weight = Number(body.weight ?? 1);

    if (!id) {
      auth.auditAdmin(request, 'create_key', false, null, 'Missing key id');
      return reply.code(400).send(proxyError('validation_error', 'Key id is required.', requestId));
    }
    if (!value) {
      auth.auditAdmin(request, 'create_key', false, id, 'Missing key value');
      return reply.code(400).send(proxyError('validation_error', 'Key value is required.', requestId));
    }
    if (!Number.isInteger(weight) || weight < 1) {
      auth.auditAdmin(request, 'create_key', false, id, 'Invalid weight');
      return reply.code(400).send(proxyError('validation_error', 'Weight must be a positive integer.', requestId));
    }
    if (deps.scheduler.getKey(id)) {
      auth.auditAdmin(request, 'create_key', false, id, 'Key already exists');
      return reply.code(409).send(proxyError('key_exists', `Key with id '${id}' already exists.`, requestId));
    }

    const secret = deps.config.encryptionSecret;
    const encrypted = secret ? encrypt(value, secret) : value;
    deps.state.upsertKey(id, encrypted, weight, true);
    deps.scheduler.addKey({ id, value, weight, enabled: true });
    deps.scheduler.updateAdaptiveStats(deps.state.listKeyStats());
    deps.config.keys = [...deps.config.keys, { id, value, weight, enabled: true }];

    auth.auditAdmin(request, 'create_key', true, id, 'Key created');
    return { ok: true, id, weight, enabled: true };
  });

  app.put('/_proxy/keys/:id', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const id = (request.params as { id: string }).id;
    const body = parseJsonBody<{ value?: string; weight?: number; enabled?: boolean }>(request);
    const requestId = requestIdFrom(request.headers);

    if (!deps.scheduler.getKey(id)) {
      auth.auditAdmin(request, 'update_key', false, id, 'Key not found');
      return reply.code(404).send(proxyError('key_not_found', `Key with id '${id}' was not found.`, requestId));
    }

    const patch: { value?: string; weight?: number; enabled?: boolean } = {};
    const secret = deps.config.encryptionSecret;

    if (body.value !== undefined) {
      const value = String(body.value).trim();
      if (!value) {
        auth.auditAdmin(request, 'update_key', false, id, 'Empty value');
        return reply.code(400).send(proxyError('validation_error', 'Key value cannot be empty.', requestId));
      }
      const encrypted = secret ? encrypt(value, secret) : value;
      deps.state.upsertKey(id, encrypted, deps.scheduler.getKey(id)!.weight, deps.scheduler.getKey(id)!.enabled);
      patch.value = value;
    }
    if (body.weight !== undefined) {
      const weight = Number(body.weight);
      if (!Number.isInteger(weight) || weight < 1) {
        auth.auditAdmin(request, 'update_key', false, id, 'Invalid weight');
        return reply.code(400).send(proxyError('validation_error', 'Weight must be a positive integer.', requestId));
      }
      if (body.value !== undefined) {
        // Already upserted above, need to update weight too
        const key = deps.scheduler.getKey(id)!;
        const encrypted = secret ? encrypt(body.value.trim(), secret) : body.value.trim();
        deps.state.upsertKey(id, encrypted, weight, key.enabled);
      } else {
        const key = deps.scheduler.getKey(id)!;
        const existingEncrypted = deps.state.getKeyValue(id);
        deps.state.upsertKey(id, existingEncrypted ?? '', weight, key.enabled);
      }
      patch.weight = weight;
    }
    if (body.enabled !== undefined) {
      const enabled = Boolean(body.enabled);
      deps.state.setEnabled(id, enabled);
      patch.enabled = enabled;
    }

    deps.scheduler.updateKey(id, patch);
    deps.scheduler.updateAdaptiveStats(deps.state.listKeyStats());

    // Sync config.keys runtime snapshot
    deps.config.keys = deps.config.keys.map((k) => k.id === id ? { ...k, ...patch } : k);

    auth.auditAdmin(request, 'update_key', true, id, `Updated: ${Object.keys(patch).join(', ')}`);
    return { ok: true, id };
  });

  app.delete('/_proxy/keys/:id', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const id = (request.params as { id: string }).id;
    const requestId = requestIdFrom(request.headers);

    if (!deps.scheduler.getKey(id)) {
      auth.auditAdmin(request, 'delete_key', false, id, 'Key not found');
      return reply.code(404).send(proxyError('key_not_found', `Key with id '${id}' was not found.`, requestId));
    }

    if (deps.state.keyCount() <= 1) {
      auth.auditAdmin(request, 'delete_key', false, id, 'Cannot delete last key');
      return reply.code(409).send(proxyError('last_key', 'Cannot delete the last remaining key. At least one key is required.', requestId));
    }

    deps.state.deleteKey(id);
    deps.scheduler.removeKey(id);
    deps.config.keys = deps.config.keys.filter((k) => k.id !== id);

    auth.auditAdmin(request, 'delete_key', true, id, 'Key deleted');
    return { ok: true, id };
  });

  // Batch import: create many keys at once
  app.post('/_proxy/keys/import', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const body = parseJsonBody<{ keys: Array<{ id?: string; value: string; weight?: number }> }>(request);
    const requestId = requestIdFrom(request.headers);
    const entries = body.keys;

    if (!Array.isArray(entries) || entries.length === 0) {
      return reply.code(400).send(proxyError('validation_error', 'Request body must include a non-empty "keys" array.', requestId));
    }
    if (entries.length > 10000) {
      return reply.code(400).send(proxyError('validation_error', 'Maximum 10000 keys per import.', requestId));
    }

    const secret = deps.config.encryptionSecret;
    let imported = 0;
    let skipped = 0;
    const errors: Array<{ index: number; id?: string; reason: string }> = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const value = String(entry.value || '').trim();
      if (!value) {
        errors.push({ index: i, reason: 'Empty key value' });
        skipped++;
        continue;
      }
      const id = String(entry.id || '').trim() || `import_${String(i + 1).padStart(4, '0')}`;
      const weight = Number(entry.weight ?? 1);
      if (!Number.isInteger(weight) || weight < 1) {
        errors.push({ index: i, id, reason: 'Weight must be a positive integer' });
        skipped++;
        continue;
      }
      if (deps.scheduler.getKey(id)) {
        skipped++;
        continue;
      }

      const encrypted = secret ? encrypt(value, secret) : value;
      deps.state.upsertKey(id, encrypted, weight, true);
      deps.scheduler.addKey({ id, value, weight, enabled: true });
      deps.config.keys = [...deps.config.keys, { id, value, weight, enabled: true }];
      imported++;
    }

    if (imported > 0) {
      deps.scheduler.updateAdaptiveStats(deps.state.listKeyStats());
    }

    auth.auditAdmin(request, 'import_keys', true, null, `Imported ${imported} keys, skipped ${skipped}`);
    return { ok: true, imported, skipped, errors: errors.slice(0, 50), totalErrors: errors.length };
  });
}
