import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requestIdFrom } from './errors.js';
import { renderPrometheusKeyMetrics } from './metrics.js';
import type { AppDeps } from './app.js';
import { createAdminAuth, parseJsonBody } from './admin/auth.js';
import { registerAdminStaticRoutes } from './admin/static.js';
import { buildConfigSummary, buildObservability, buildPrometheusOperationsMetrics } from './admin/observability.js';
import { registerKeyActionRoutes } from './admin/keyActions.js';
import { createAlertWebhookState, maybeDispatchAlertWebhook, registerWebhookRoutes } from './admin/webhook.js';

function logQueryFromRequest(request: FastifyRequest): { limit: number; keyId?: string; path?: string; status?: string; from?: number; to?: number; errorOnly?: boolean } {
  const query = request.query as Record<string, string | undefined>;
  return {
    limit: Number(query.limit ?? 100),
    keyId: query.keyId,
    path: query.path,
    status: query.status,
    from: query.from ? Number(query.from) : undefined,
    to: query.to ? Number(query.to) : undefined,
    errorOnly: query.errorOnly === 'true'
  };
}

function auditQueryFromRequest(request: FastifyRequest): { limit: number; action?: string; success?: boolean; from?: number; to?: number } {
  const query = request.query as Record<string, string | undefined>;
  const success = query.success === undefined || query.success === '' ? undefined : query.success === 'true';
  return {
    limit: Number(query.limit ?? 5000),
    action: query.action,
    success,
    from: query.from ? Number(query.from) : undefined,
    to: query.to ? Number(query.to) : undefined
  };
}

function csvCell(value: unknown): string {
  const text = Array.isArray(value) ? value.join(' -> ') : String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildLogCsv(logs: ReturnType<AppDeps['state']['listRequestLogs']>): string {
  const header = ['createdAt', 'requestId', 'method', 'path', 'query', 'status', 'attempts', 'latencyMs', 'keyIds', 'tokenId', 'errorCode'];
  const rows = logs.map((log) => [log.createdAt, log.requestId, log.method, log.path, log.query, log.status, log.attempts, log.latencyMs, log.keyIds, log.tokenId, log.errorCode].map(csvCell).join(','));
  return [header.join(','), ...rows].join('\n');
}

function buildAuditCsv(logs: ReturnType<AppDeps['state']['listAdminAuditLogs']>): string {
  const header = ['createdAt', 'actorTokenId', 'action', 'targetId', 'success', 'detail', 'ip', 'userAgent'];
  const rows = logs.map((log) => [log.createdAt, log.actorTokenId, log.action, log.targetId, log.success, log.detail, log.ip, log.userAgent].map(csvCell).join(','));
  return [header.join(','), ...rows].join('\n');
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const auth = createAdminAuth(deps);
  const alertWebhookState = createAlertWebhookState();

  await registerAdminStaticRoutes(app);

  app.post('/_proxy/session', async (request, reply) => auth.login(request, reply));
  app.delete('/_proxy/session', async (request, reply) => auth.logout(request, reply));

  app.get('/_proxy/health', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    return {
      ok: true,
      keys: deps.config.keys.length,
      session: auth.sessionSummary(request)
    };
  });

  app.get('/_proxy/config-summary', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    return buildConfigSummary(deps);
  });

  app.get('/_proxy/events', async (request, reply) => {
    const authRequest = auth.requestWithQuerySession(request);
    if (!auth.requireAdmin(authRequest, reply)) return reply;
    const snapshot = () => ({
      ts: Date.now(),
      keyCount: deps.state.listKeyStats().length,
      logCount: deps.state.listRequestLogs({ limit: 1 }).length,
      auditCount: deps.state.listAdminAuditLogs(1).length,
      alerts: (buildObservability(deps, deps.config.trendWindowHours).alerts as unknown[]).length
    });
    const encode = (payload: Record<string, unknown>) => `event: snapshot
data: ${JSON.stringify(payload)}

`;
    const query = request.query as { once?: string };
    if (query.once === 'true') {
      return reply
        .type('text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('connection', 'keep-alive')
        .send(encode(snapshot()));
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });
    const sendSnapshot = () => reply.raw.write(encode(snapshot()));
    sendSnapshot();
    const timer = setInterval(sendSnapshot, 5000);
    request.raw.on('close', () => clearInterval(timer));
  });

  app.get('/_proxy/logs', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    return { logs: deps.state.listRequestLogs(logQueryFromRequest(request)) };
  });

  app.get('/_proxy/logs/trace/:requestId', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const requestId = (request.params as { requestId: string }).requestId;
    return { requestId, trace: deps.state.getRequestTrace(requestId) };
  });

  app.get('/_proxy/logs/export', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const logs = deps.state.listRequestLogs({ ...logQueryFromRequest(request), limit: Math.min(Number((request.query as any).limit ?? 5000), 5000) });
    auth.auditAdmin(request, 'export_logs', true, null, `${logs.length} rows`);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="exa-request-logs.csv"')
      .send(buildLogCsv(logs));
  });

  app.post('/_proxy/logs/prune', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const body = parseJsonBody<{ olderThanMs: number; days: number }>(request);
    const cutoff = body.olderThanMs ? Number(body.olderThanMs) : Date.now() - Number(body.days ?? deps.config.logRetentionDays) * 86400000;
    const deleted = deps.state.pruneRequestLogs(cutoff);
    auth.auditAdmin(request, 'prune_logs', true, null, `${deleted} rows before ${cutoff}`);
    return { ok: true, deleted, olderThanMs: cutoff };
  });

  app.get('/_proxy/observability', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const query = request.query as { hours?: string };
    const observability = buildObservability(deps, query.hours ? Number(query.hours) : undefined);
    return {
      ...observability,
      webhook: await maybeDispatchAlertWebhook(deps, request, observability, alertWebhookState, auth)
    };
  });

  app.get('/_proxy/audit', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const query = request.query as { limit?: string };
    return { audit: deps.state.listAdminAuditLogs(Number(query.limit ?? 50)) };
  });

  app.get('/_proxy/audit/export', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const audit = deps.state.listAdminAuditLogs(auditQueryFromRequest(request));
    auth.auditAdmin(request, 'export_audit', true, null, `${audit.length} rows`);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="exa-admin-audit.csv"')
      .send(buildAuditCsv(audit));
  });

  app.get('/_proxy/metrics', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    const observability = buildObservability(deps, deps.config.trendWindowHours);
    return reply.type('text/plain; version=0.0.4').send(renderPrometheusKeyMetrics(
      deps.state.listKeyStats(),
      buildPrometheusOperationsMetrics(deps, observability)
    ));
  });

  registerWebhookRoutes(app, deps, auth, alertWebhookState);
  registerKeyActionRoutes(app, deps, auth);
}
