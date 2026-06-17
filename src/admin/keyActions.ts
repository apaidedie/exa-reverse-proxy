import type { FastifyInstance } from 'fastify';
import { proxyError, requestIdFrom } from '../errors.js';
import { classifyError, classifyStatus, parseRetryAfterMs } from '../retry.js';
import { callUpstream, type UpstreamResponse } from '../upstream.js';
import type { AppDeps, KeyConfig } from '../app.js';
import type { AdminAuthContext } from './auth.js';
import { parseJsonBody } from './auth.js';

type KeyTestResult = { ok: boolean; id: string; status: number; latencyMs: number; reason: string };

async function consumeBody(response: UpstreamResponse): Promise<void> {
  for await (const _chunk of response.body) {
    // Drain the upstream response so the connection can be reused.
  }
}

export function adminKeyStats(deps: AppDeps): Array<Record<string, unknown>> {
  const displayById = new Map(deps.config.keys.map((key) => [key.id, key.value]));
  return deps.state.listKeyStats().map((key) => ({
    ...key,
    displayId: deps.config.allowRawKeyDisplay ? displayById.get(key.id) ?? key.id : key.id,
    rawKeyDisplayAllowed: deps.config.allowRawKeyDisplay
  }));
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
        const key = deps.config.keys.find((item) => item.id === id);
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
    const key = deps.config.keys.find((item) => item.id === id);
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
    const key = deps.config.keys.find((item) => item.id === id);
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
}
