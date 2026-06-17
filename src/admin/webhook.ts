import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import { request as undiciRequest } from 'undici';
import type { AppDeps } from '../app.js';
import { proxyError, requestIdFrom } from '../errors.js';
import type { AdminAuthContext } from './auth.js';
import { sleep } from '../util/shared.js';

export type AlertWebhookState = {
  lastSignature: string;
  lastSentAt: number;
  lastStatus: 'disabled' | 'idle' | 'sent' | 'cooldown' | 'failed';
  lastError: string | null;
  lastStatusCode: number | null;
  lastAttempts: number;
  signed: boolean;
};

type DeliveryResult = {
  ok: boolean;
  statusCode: number | null;
  attempts: number;
  error: string | null;
  signed: boolean;
};

export function createAlertWebhookState(): AlertWebhookState {
  return {
    lastSignature: '',
    lastSentAt: 0,
    lastStatus: 'disabled',
    lastError: null,
    lastStatusCode: null,
    lastAttempts: 0,
    signed: false
  };
}

export function publicWebhookTarget(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function alertSignature(alerts: Array<Record<string, unknown>>): string {
  return alerts
    .map((alert) => `${alert.id ?? ''}:${alert.severity ?? ''}:${alert.value ?? ''}`)
    .sort()
    .join('|');
}

function signBody(body: string, secret: string | null): string | null {
  if (!secret) return null;
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function deliverWebhook(deps: AppDeps, payload: Record<string, unknown>): Promise<DeliveryResult> {
  const webhookUrl = deps.config.alertWebhookUrl;
  if (!webhookUrl) return { ok: false, statusCode: null, attempts: 0, error: 'webhook disabled', signed: false };

  const body = JSON.stringify(payload);
  const signature = signBody(body, deps.config.alertWebhookHmacSecret);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'exa-reverse-proxy-alert-webhook'
  };
  if (deps.config.alertWebhookBearerToken) headers.authorization = `Bearer ${deps.config.alertWebhookBearerToken}`;
  if (signature) headers['x-exa-alert-signature'] = signature;

  const maxAttempts = Math.max(1, Math.min(5, Math.round(deps.config.alertWebhookMaxAttempts || 1)));
  let lastStatusCode: number | null = null;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await undiciRequest(webhookUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
      // Consume body to allow connection reuse
      for await (const _ of response.body) { /* drain */ }
      lastStatusCode = response.statusCode;
      if (response.statusCode >= 200 && response.statusCode < 300) return { ok: true, statusCode: response.statusCode, attempts: attempt, error: null, signed: Boolean(signature) };
      lastError = `HTTP ${response.statusCode}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'webhook failed';
    }
    if (attempt < maxAttempts) await sleep(deps.config.alertWebhookRetryBackoffMs);
  }

  return { ok: false, statusCode: lastStatusCode, attempts: maxAttempts, error: lastError, signed: Boolean(signature) };
}

function updateStateFromDelivery(state: AlertWebhookState, delivery: DeliveryResult, now: number, signature: string): void {
  state.lastSignature = signature;
  state.lastSentAt = now;
  state.lastStatus = delivery.ok ? 'sent' : 'failed';
  state.lastError = delivery.ok ? null : delivery.error;
  state.lastStatusCode = delivery.statusCode;
  state.lastAttempts = delivery.attempts;
  state.signed = delivery.signed;
}

function webhookStatusPayload(deps: AppDeps, state: AlertWebhookState): Record<string, unknown> {
  return {
    enabled: Boolean(deps.config.alertWebhookUrl),
    target: publicWebhookTarget(deps.config.alertWebhookUrl),
    lastStatus: state.lastStatus,
    lastSentAt: state.lastSentAt || null,
    lastError: state.lastError,
    lastStatusCode: state.lastStatusCode,
    lastAttempts: state.lastAttempts,
    signed: state.signed
  };
}

export async function maybeDispatchAlertWebhook(
  deps: AppDeps,
  request: FastifyRequest,
  observability: Record<string, unknown>,
  state: AlertWebhookState,
  auth: AdminAuthContext
): Promise<Record<string, unknown>> {
  const webhookUrl = deps.config.alertWebhookUrl;
  if (!webhookUrl) {
    state.lastStatus = 'disabled';
    return { enabled: false, lastStatus: state.lastStatus };
  }

  const alerts = Array.isArray(observability.alerts) ? observability.alerts as Array<Record<string, unknown>> : [];
  if (alerts.length === 0) {
    state.lastStatus = 'idle';
    state.lastError = null;
    return webhookStatusPayload(deps, state);
  }

  const now = Date.now();
  const signature = alertSignature(alerts);
  const cooldownMs = deps.config.alertWebhookCooldownSeconds * 1000;
  if (signature === state.lastSignature && now - state.lastSentAt < cooldownMs) {
    state.lastStatus = 'cooldown';
    return {
      ...webhookStatusPayload(deps, state),
      cooldownUntil: state.lastSentAt + cooldownMs
    };
  }

  const payload = {
    service: 'exa-reverse-proxy',
    createdAt: now,
    window: observability.window,
    thresholds: observability.thresholds,
    retention: observability.retention,
    alerts
  };
  const delivery = await deliverWebhook(deps, payload);
  updateStateFromDelivery(state, delivery, now, signature);
  auth.auditAdmin(request, 'alert_webhook', delivery.ok, null, delivery.error ?? `${alerts.length} alerts sent`);

  return {
    ...webhookStatusPayload(deps, state),
    cooldownUntil: state.lastSentAt + cooldownMs
  };
}

export async function sendTestAlertWebhook(deps: AppDeps, request: FastifyRequest, reply: any, auth: AdminAuthContext, state: AlertWebhookState): Promise<Record<string, unknown> | void> {
  if (!deps.config.alertWebhookUrl) {
    const requestId = requestIdFrom(request.headers);
    auth.auditAdmin(request, 'test_alert_webhook', false, null, 'Webhook disabled');
    return reply.code(400).send(proxyError('webhook_disabled', 'Alert webhook is not configured.', requestId));
  }

  const now = Date.now();
  const payload = {
    service: 'exa-reverse-proxy',
    createdAt: now,
    window: { label: '测试告警' },
    thresholds: {},
    retention: {},
    alerts: [{
      id: 'webhook_test',
      severity: 'info',
      title: 'Webhook 测试',
      message: '这是一条由 Exa 代理控制台发送的测试告警。',
      value: 1
    }]
  };
  const delivery = await deliverWebhook(deps, payload);
  updateStateFromDelivery(state, delivery, now, `webhook_test:${now}`);
  auth.auditAdmin(request, 'test_alert_webhook', delivery.ok, null, delivery.error ?? `HTTP ${delivery.statusCode}`);
  return {
    ok: delivery.ok,
    statusCode: delivery.statusCode,
    attempts: delivery.attempts,
    error: delivery.error,
    signed: delivery.signed
  };
}

export function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps, auth: AdminAuthContext, state: AlertWebhookState): void {
  app.post('/_proxy/alerts/webhook/test', async (request, reply) => {
    if (!auth.requireAdmin(request, reply)) return reply;
    return sendTestAlertWebhook(deps, request, reply, auth, state);
  });
}
