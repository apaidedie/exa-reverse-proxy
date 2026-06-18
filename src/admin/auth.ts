import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { extractToken, isAuthorized, presentedTokenId, tokenId } from '../auth.js';
import { proxyError, requestIdFrom } from '../errors.js';
import type { AppDeps } from '../app.js';
import type { AdminSessionRecord } from '../state.js';
import { headerValue as sharedHeaderValue } from '../util/shared.js';

// Wrapper that accepts FastifyRequest for backward compatibility with admin code
export function headerValue(request: FastifyRequest, name: string): string | undefined {
  return sharedHeaderValue(request.headers, name);
}

type AuthFailureState = { failures: number[]; lockedUntil: number };

export type AdminAuthContext = {
  requireAdmin(request: FastifyRequest, reply: any): boolean;
  currentActor(request: FastifyRequest): string | null;
  auditAdmin(request: FastifyRequest, action: string, success: boolean, targetId?: string | null, detail?: string | null): void;
  headerValue(request: FastifyRequest, name: string): string | undefined;
  requestWithQuerySession(request: FastifyRequest): FastifyRequest;
  login(request: FastifyRequest, reply: any): Promise<Record<string, unknown> | void>;
  logout(request: FastifyRequest, reply: any): Promise<Record<string, unknown> | void>;
  sessionSummary(request: FastifyRequest): Record<string, unknown> | null;
};

export function parseJsonBody<T extends Record<string, unknown>>(request: FastifyRequest): Partial<T> {
  const body = request.body;
  if (!body) return {};
  try {
    if (Buffer.isBuffer(body)) {
      const text = body.toString('utf8').trim();
      return text ? JSON.parse(text) : {};
    }
    if (typeof body === 'string') return body.trim() ? JSON.parse(body) : {};
    if (typeof body === 'object') return body as Partial<T>;
    return {};
  } catch {
    return {};
  }
}

function requestIp(request: FastifyRequest): string {
  const forwarded = headerValue(request, 'x-forwarded-for');
  return (forwarded?.split(',')[0] || request.ip || 'unknown').trim();
}

function requestWithQuerySession(request: FastifyRequest): FastifyRequest {
  const querySession = (request.query as { sessionId?: string } | undefined)?.sessionId;
  if (!querySession || headerValue(request, 'x-admin-session-id')) return request;
  return { ...request, headers: { ...request.headers, 'x-admin-session-id': querySession } } as FastifyRequest;
}

function authBucket(request: FastifyRequest): string {
  return `${requestIp(request)}|${headerValue(request, 'user-agent') ?? ''}`;
}

function isSecureRequest(request: FastifyRequest): boolean {
  const forwardedProto = headerValue(request, 'x-forwarded-proto');
  return forwardedProto === 'https' || (request as any).protocol === 'https';
}

export function createAdminAuth(deps: AppDeps): AdminAuthContext {
  const adminFailures = new Map<string, AuthFailureState>();
  deps.state.pruneAdminSessions(Date.now());

  // Periodically clean up stale auth failure entries to prevent memory leaks
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const windowMs = deps.config.adminLockoutWindowSeconds * 1000;
    for (const [key, state] of adminFailures) {
      const recentFailures = state.failures.filter((time) => now - time <= windowMs);
      if (recentFailures.length === 0 && state.lockedUntil <= now) {
        adminFailures.delete(key);
      } else {
        state.failures = recentFailures;
      }
    }
  }, 60_000);
  cleanupInterval.unref?.();

  function lockoutLeftMs(request: FastifyRequest): number {
    const state = adminFailures.get(authBucket(request));
    return Math.max(0, (state?.lockedUntil ?? 0) - Date.now());
  }

  function recordAuthFailure(request: FastifyRequest): void {
    const now = Date.now();
    const key = authBucket(request);
    const windowMs = deps.config.adminLockoutWindowSeconds * 1000;
    const failureState = adminFailures.get(key) ?? { failures: [], lockedUntil: 0 };
    failureState.failures = failureState.failures.filter((time) => now - time <= windowMs);
    failureState.failures.push(now);
    if (failureState.failures.length >= deps.config.adminLockoutMaxFailures) {
      failureState.lockedUntil = now + deps.config.adminLockoutSeconds * 1000;
      failureState.failures = [];
    }
    adminFailures.set(key, failureState);
  }

  function clearAuthFailures(request: FastifyRequest): void {
    adminFailures.delete(authBucket(request));
  }

  function cleanExpiredSessions(): void {
    deps.state.pruneAdminSessions(Date.now());
  }

  function validSession(request: FastifyRequest): AdminSessionRecord | null {
    cleanExpiredSessions();
    const sessionId = headerValue(request, 'x-admin-session-id');
    if (!sessionId) return null;
    const session = deps.state.getAdminSession(sessionId);
    const now = Date.now();
    if (!session || session.expiresAt <= now) return null;
    deps.state.touchAdminSession(sessionId, now);
    return { ...session, lastSeenAt: now };
  }

  function actorTokenId(request: FastifyRequest): string | null {
    const session = validSession(request);
    if (session) return session.tokenId;
    return presentedTokenId(request.headers, deps.config.adminTokens) ?? null;
  }

  function auditAdmin(request: FastifyRequest, action: string, success: boolean, targetId?: string | null, detail?: string | null): void {
    deps.state.recordAdminAudit({
      actorTokenId: actorTokenId(request),
      action,
      targetId: targetId ?? null,
      success,
      detail: detail ?? null,
      ip: requestIp(request),
      userAgent: headerValue(request, 'user-agent') ?? null
    });
  }

  function requireAdmin(request: FastifyRequest, reply: any): boolean {
    if (deps.config.adminRequireHttps && !isSecureRequest(request)) {
      const requestId = requestIdFrom(request.headers);
      auditAdmin(request, 'admin_https_required', false, null, 'Admin API requires HTTPS.');
      reply.code(426).send(proxyError('https_required', 'Admin API requires HTTPS.', requestId));
      return false;
    }

    const session = validSession(request);
    if (session) return true;

    if (isAuthorized(request.headers, deps.config.adminTokens)) return true;
    const requestId = requestIdFrom(request.headers);
    reply.code(401).send(proxyError('unauthorized', 'Unauthorized', requestId));
    return false;
  }

  async function login(request: FastifyRequest, reply: any): Promise<Record<string, unknown> | void> {
    const requestId = requestIdFrom(request.headers);
    if (deps.config.adminRequireHttps && !isSecureRequest(request)) {
      auditAdmin(request, 'login', false, null, 'HTTPS required');
      return reply.code(426).send(proxyError('https_required', 'Admin API requires HTTPS.', requestId));
    }

    const lockoutMs = lockoutLeftMs(request);
    if (lockoutMs > 0) {
      auditAdmin(request, 'login', false, null, `Locked for ${Math.ceil(lockoutMs / 1000)} seconds`);
      return reply.code(423).send(proxyError('admin_locked', 'Too many failed login attempts. Try again later.', requestId));
    }

    const token = extractToken(request.headers);
    if (!token || !isAuthorized(request.headers, deps.config.adminTokens)) {
      recordAuthFailure(request);
      auditAdmin(request, 'login', false, null, 'Invalid admin token');
      return reply.code(401).send(proxyError('unauthorized', 'Unauthorized', requestId));
    }

    clearAuthFailures(request);
    const sessionId = randomUUID();
    const now = Date.now();
    const session = {
      id: sessionId,
      tokenId: tokenId(token),
      createdAt: now,
      expiresAt: now + deps.config.adminSessionTtlSeconds * 1000,
      lastSeenAt: now
    };
    deps.state.createAdminSession(session);
    auditAdmin(request, 'login', true, null, 'Session created');
    return { ok: true, sessionId, tokenId: session.tokenId, expiresAt: session.expiresAt };
  }

  async function logout(request: FastifyRequest, reply: any): Promise<Record<string, unknown> | void> {
    if (!requireAdmin(request, reply)) return reply;
    auditAdmin(request, 'logout', true, null, 'Session revoked');
    const sessionId = headerValue(request, 'x-admin-session-id');
    if (sessionId) deps.state.deleteAdminSession(sessionId);
    return { ok: true };
  }

  function sessionSummary(request: FastifyRequest): Record<string, unknown> | null {
    const session = validSession(request);
    return session ? { tokenId: session.tokenId, expiresAt: session.expiresAt } : null;
  }

  return {
    requireAdmin,
    currentActor: actorTokenId,
    auditAdmin,
    headerValue,
    requestWithQuerySession,
    login,
    logout,
    sessionSummary
  };
}
