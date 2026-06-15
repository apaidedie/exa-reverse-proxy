import type { FastifyReply, FastifyRequest } from 'fastify';
import { buildUpstreamHeaders, sanitizeResponseHeaders } from './headers.js';
import { isAuthorized, presentedTokenId } from './auth.js';
import { proxyError, requestIdFrom } from './errors.js';
import { isAllowedPath, isRetrySafe, parseResourceAffinity, createdResourceFromResponse } from './routes.js';
import { callUpstream, type UpstreamResponse } from './upstream.js';
import { classifyError, classifyStatus, parseRetryAfterMs, retryBackoffMs, sleep } from './retry.js';
import type { AppDeps, KeyConfig } from './app.js';

function pathAndQuery(request: FastifyRequest): string {
  return request.url;
}

function pathnameOf(request: FastifyRequest): string {
  return new URL(request.url, 'http://proxy.local').pathname;
}

function requestBody(request: FastifyRequest): Buffer | undefined {
  if (Buffer.isBuffer(request.body)) return request.body;
  if (request.body === undefined || request.body === null) return undefined;
  if (typeof request.body === 'string') return Buffer.from(request.body);
  return Buffer.from(JSON.stringify(request.body));
}

async function bufferBody(response: UpstreamResponse): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function contentType(headers: Record<string, string | string[] | undefined>): string {
  const value = headers['content-type'];
  return Array.isArray(value) ? value.join(',') : value ?? '';
}

function statusIsSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function statusCountsAsSuccess(status: number): boolean {
  return status >= 200 && status < 400;
}

function errorStatusForReason(reason: string): { status: number; code: string; message: string } {
  if (reason === 'timeout') return { status: 504, code: 'upstream_timeout', message: 'All upstream attempts timed out.' };
  return { status: 502, code: 'upstream_error', message: 'The upstream Exa API could not be reached.' };
}

function logErrorCodeForUpstreamStatus(status: number): string | null {
  if (status < 400) return null;
  const decision = classifyStatus(status);
  return decision.reason === 'ok' ? 'upstream_error' : decision.reason;
}

async function sendUpstreamResponse(
  reply: FastifyReply,
  response: UpstreamResponse,
  request: FastifyRequest,
  key: KeyConfig,
  deps: AppDeps,
  pathname: string
): Promise<void> {
  const headers = sanitizeResponseHeaders(response.headers);
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  reply.code(response.statusCode);

  const type = contentType(response.headers).toLowerCase();
  const canInspectJson = deps.config.resourceAffinity && statusIsSuccess(response.statusCode) && type.includes('application/json') && !type.includes('text/event-stream');

  if (!canInspectJson) {
    return reply.send(response.body);
  }

  const bodyBuffer = await bufferBody(response);
  try {
    const parsed = JSON.parse(bodyBuffer.toString('utf8'));
    const created = createdResourceFromResponse(request.method, pathname, parsed);
    if (created) deps.state.setAffinity(created.type, created.id, key.id);
  } catch {
    return reply.send(bodyBuffer);
  }
  return reply.send(bodyBuffer);
}

function chooseAffinityKey(pathname: string, deps: AppDeps, now: number): { key?: KeyConfig; unavailable: boolean } {
  if (!deps.config.resourceAffinity) return { unavailable: false };
  const affinity = parseResourceAffinity(pathname);
  if (!affinity) return { unavailable: false };
  const keyId = deps.state.getAffinity(affinity.type, affinity.id);
  if (!keyId) return { unavailable: false };
  const key = deps.scheduler.getById(keyId, now);
  return key ? { key, unavailable: false } : { unavailable: true };
}

function recordLog(deps: AppDeps, record: Parameters<AppDeps['state']['recordRequestLog']>[0]): void {
  deps.state.recordRequestLog(record);
}

function recordAttempt(deps: AppDeps, record: Parameters<AppDeps['state']['recordAttempt']>[0]): void {
  deps.state.recordAttempt(record);
  deps.scheduler.updateAdaptiveStats(deps.state.listKeyStats());
}

export async function proxyHandler(request: FastifyRequest, reply: FastifyReply, deps: AppDeps): Promise<FastifyReply | void> {
  const start = Date.now();
  const requestId = requestIdFrom(request.headers);
  const pathname = pathnameOf(request);
  const tokenId = presentedTokenId(request.headers, deps.config.proxyTokens) ?? null;

  if (pathname.startsWith('/_proxy/')) {
    return reply.code(404).send(proxyError('route_not_found', 'Proxy admin route was not found.', requestId));
  }

  if (!isAuthorized(request.headers, deps.config.proxyTokens)) {
    recordLog(deps, { requestId, tokenId, method: request.method, path: pathname, status: 401, keyIds: [], attempts: 0, latencyMs: Date.now() - start, errorCode: 'unauthorized' });
    return reply.code(401).send(proxyError('unauthorized', 'Unauthorized', requestId));
  }

  if (!isAllowedPath(pathname, deps.config.allowedPaths)) {
    recordLog(deps, { requestId, tokenId, method: request.method, path: pathname, status: 403, keyIds: [], attempts: 0, latencyMs: Date.now() - start, errorCode: 'route_forbidden' });
    return reply.code(403).send(proxyError('route_forbidden', 'This Exa route is not allowed by proxy configuration.', requestId));
  }

  const safeToRetry = isRetrySafe(request.method, pathname, request.headers);
  const maxAttempts = safeToRetry ? Math.max(1, deps.config.maxAttempts) : 1;
  const body = requestBody(request);
  const attempted = new Set<string>();
  const keyIds: string[] = [];
  let finalStatus = 503;
  let finalErrorCode: string | null = null;
  let lastResponse: UpstreamResponse | undefined;
  let lastErrorReason = 'unknown_error';

  const affinityChoice = chooseAffinityKey(pathname, deps, Date.now());
  if (affinityChoice.unavailable) {
    finalErrorCode = 'affinity_key_unavailable';
    recordLog(deps, { requestId, tokenId, method: request.method, path: pathname, status: 503, keyIds, attempts: 0, latencyMs: Date.now() - start, errorCode: finalErrorCode });
    return reply.code(503).send(proxyError('affinity_key_unavailable', 'The key that owns this resource is not currently available.', requestId));
  }

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const now = Date.now();
      const key = attempt === 0 && affinityChoice.key ? affinityChoice.key : deps.scheduler.next(now, attempted);
      if (!key) break;
      attempted.add(key.id);
      keyIds.push(key.id);
      const attemptStart = Date.now();

      try {
        const upstream = await callUpstream({
          baseUrl: deps.config.upstreamUrl,
          pathAndQuery: pathAndQuery(request),
          method: request.method,
          headers: buildUpstreamHeaders(request.headers, { upstreamKey: key.value, requestId }),
          body,
          timeoutMs: deps.config.attemptTimeoutMs
        });

        const latencyMs = Date.now() - attemptStart;
        const decision = classifyStatus(upstream.statusCode);
        finalStatus = upstream.statusCode;
        lastResponse = upstream;
        lastErrorReason = decision.reason;
        recordAttempt(deps, { keyId: key.id, status: upstream.statusCode, success: statusCountsAsSuccess(upstream.statusCode), latencyMs, retry: attempt > 0, reason: decision.reason });

        if (decision.reason === 'rate_limit') {
          const retryAfterMs = parseRetryAfterMs(Array.isArray(upstream.headers['retry-after']) ? upstream.headers['retry-after'][0] : upstream.headers['retry-after']);
          const until = Date.now() + (retryAfterMs ?? deps.config.rateLimitCooldownSeconds * 1000);
          deps.scheduler.coolDown(key.id, until, Date.now(), 'rate_limit');
          deps.state.setCooldown(key.id, until, 'rate_limit');
        } else if (decision.retryable) {
          const until = deps.scheduler.recordFailure(
            key.id,
            Date.now(),
            deps.config.failureThreshold,
            deps.config.failureWindowSeconds * 1000,
            deps.config.cooldownSeconds * 1000,
            decision.reason
          );
          if (until) deps.state.setCooldown(key.id, until, decision.reason);
        } else {
          deps.scheduler.recordSuccess(key.id);
        }

        if (!decision.retryable || attempt === maxAttempts - 1) {
          break;
        }

        await bufferBody(upstream);
        await sleep(retryBackoffMs(deps.config.retryBackoffMs, attempt));
      } catch (error) {
        const latencyMs = Date.now() - attemptStart;
        const decision = classifyError(error);
        lastErrorReason = decision.reason;
        recordAttempt(deps, { keyId: key.id, status: null, success: false, latencyMs, retry: attempt > 0, reason: decision.reason });
        const until = deps.scheduler.recordFailure(
          key.id,
          Date.now(),
          deps.config.failureThreshold,
          deps.config.failureWindowSeconds * 1000,
          deps.config.cooldownSeconds * 1000,
          decision.reason
        );
        if (until) deps.state.setCooldown(key.id, until, decision.reason);
        if (!decision.retryable || attempt === maxAttempts - 1) break;
        await sleep(retryBackoffMs(deps.config.retryBackoffMs, attempt));
      }
    }
  } finally {
    // Ensure response body is consumed to avoid connection leaks
    // Only clean up if we're NOT going to send this response
    if (lastResponse && !reply.sent && keyIds.length === 0) {
      try {
        await bufferBody(lastResponse);
      } catch {
        // Silent failure - best effort cleanup
      }
    }
  }

  if (lastResponse) {
    recordLog(deps, { requestId, tokenId, method: request.method, path: pathname, status: finalStatus, keyIds, attempts: keyIds.length, latencyMs: Date.now() - start, errorCode: logErrorCodeForUpstreamStatus(finalStatus) });
    const selectedKey = deps.config.keys.find((key) => key.id === keyIds[keyIds.length - 1]);
    if (!selectedKey) return reply.code(502).send(proxyError('upstream_error', 'The upstream key selection could not be resolved.', requestId));
    return sendUpstreamResponse(reply, lastResponse, request, selectedKey, deps, pathname);
  }

  if (keyIds.length === 0) {
    finalErrorCode = 'no_healthy_keys';
    recordLog(deps, { requestId, tokenId, method: request.method, path: pathname, status: 503, keyIds, attempts: 0, latencyMs: Date.now() - start, errorCode: finalErrorCode });
    return reply.code(503).send(proxyError('no_healthy_keys', 'No healthy Exa API key is currently available.', requestId));
  }

  const errorStatus = errorStatusForReason(lastErrorReason);
  recordLog(deps, { requestId, tokenId, method: request.method, path: pathname, status: errorStatus.status, keyIds, attempts: keyIds.length, latencyMs: Date.now() - start, errorCode: errorStatus.code });
  return reply.code(errorStatus.status).send(proxyError(errorStatus.code, errorStatus.message, requestId));
}
