import type { AppDeps } from '../app.js';
import type { PrometheusOperationsMetrics } from '../metrics.js';
import { percentile } from '../util/shared.js';

type Buckets = ReturnType<AppDeps['state']['requestTrend']>;
type RequestLogs = ReturnType<AppDeps['state']['listRequestLogs']>;

function publicUrlTarget(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return null;
  }
}

function sumBuckets(buckets: Buckets, from: number, to: number): { requests: number; failures: number; rateLimits: number } {
  return buckets.reduce((sum, bucket) => {
    if (bucket.bucketStart >= from && bucket.bucketStart < to) {
      sum.requests += bucket.requests;
      sum.failures += bucket.failures;
      sum.rateLimits += bucket.rateLimits;
    }
    return sum;
  }, { requests: 0, failures: 0, rateLimits: 0 });
}

function trendWindowFromHours(rawHours: number | undefined, fallbackHours: number): { hours: number; label: string; bucketMs: number; windowMs: number } {
  const hours = [1, 24, 168].includes(Number(rawHours)) ? Number(rawHours) : fallbackHours;
  const bucketMs = hours <= 2 ? 5 * 60 * 1000 : hours <= 48 ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const label = hours === 1 ? '近 1 小时' : hours === 168 ? '近 7 天' : `近 ${hours} 小时`;
  return { hours, label, bucketMs, windowMs: hours * 60 * 60 * 1000 };
}

function statusGroup(status: number): string {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

function lowCardinalityReason(reason: string | null | undefined): string {
  const value = String(reason || 'none').toLowerCase();
  const allowed = new Set([
    'ok',
    'rate_limit',
    'credits_exhausted',
    'timeout',
    'upstream_timeout',
    'transient_status',
    'client_status',
    'connection_error',
    'upstream_5xx',
    'upstream_error',
    'unknown_error',
    'no_healthy_keys',
    'manual_reset',
    'route_forbidden',
    'unauthorized',
    'none'
  ]);
  return allowed.has(value) ? value : 'other';
}

function summarizeLogs(logs: RequestLogs): {
  statusGroups: Record<string, number>;
  requestLatencyP95Ms: number;
  upstreamErrors: Record<string, number>;
} {
  const statusGroups: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  const upstreamErrors: Record<string, number> = {};
  const latencies: number[] = [];
  for (const log of logs) {
    statusGroups[statusGroup(Number(log.status))] += 1;
    latencies.push(Number(log.latencyMs || 0));
    if (log.errorCode || Number(log.status) >= 400) {
      const reason = lowCardinalityReason(log.errorCode || (Number(log.status) >= 500 ? 'upstream_error' : 'client_status'));
      upstreamErrors[reason] = (upstreamErrors[reason] ?? 0) + 1;
    }
  }
  return { statusGroups, requestLatencyP95Ms: percentile(latencies, 0.95), upstreamErrors };
}

export function buildObservability(deps: AppDeps, hours?: number): Record<string, unknown> {
  const now = Date.now();
  const window = trendWindowFromHours(hours, deps.config.trendWindowHours);
  const trends = deps.state.requestTrend(now - window.windowMs, window.bucketMs);
  const keys = deps.state.listKeyStats();
  const healthy = keys.filter((key) => key.enabled && Number(key.cooldownUntil || 0) <= now).length;
  const cooldown = keys.filter((key) => key.enabled && Number(key.cooldownUntil || 0) > now).length;
  const disabled = keys.filter((key) => !key.enabled).length;
  const current = sumBuckets(trends, now - 60 * 60 * 1000, now + window.bucketMs);
  const previous = sumBuckets(trends, now - 2 * 60 * 60 * 1000, now - 60 * 60 * 1000);
  const failureRate = current.requests ? current.failures / current.requests * 100 : 0;
  const rateLimitRate = current.requests ? current.rateLimits / current.requests * 100 : 0;
  const alerts: Array<Record<string, unknown>> = [];
  if (healthy <= deps.config.alertAvailableKeyMin) alerts.push({ id: 'available_keys_low', severity: healthy === 0 ? 'bad' : 'warn', title: '可用密钥过低', message: `当前可用密钥 ${healthy} 个，低于阈值 ${deps.config.alertAvailableKeyMin}。`, value: healthy });
  if (failureRate >= deps.config.alertFailureRatePercent && current.requests > 0) alerts.push({ id: 'failure_rate_high', severity: 'warn', title: '失败率偏高', message: `近 1 小时失败率 ${failureRate.toFixed(2)}%。`, value: Number(failureRate.toFixed(2)) });
  if (rateLimitRate >= deps.config.alertRateLimitRatePercent && current.requests > 0) alerts.push({ id: 'rate_limit_rate_high', severity: 'warn', title: '429 比例偏高', message: `近 1 小时 429 比例 ${rateLimitRate.toFixed(2)}%。`, value: Number(rateLimitRate.toFixed(2)) });
  if (current.failures >= Math.max(5, previous.failures * 2) && current.failures > previous.failures) alerts.push({ id: 'failure_spike', severity: 'bad', title: '失败突增', message: `近 1 小时失败 ${current.failures} 次，上一小时 ${previous.failures} 次。`, value: current.failures });
  if (current.rateLimits >= Math.max(5, previous.rateLimits * 2) && current.rateLimits > previous.rateLimits) alerts.push({ id: 'rate_limit_spike', severity: 'warn', title: '429 突增', message: `近 1 小时 429 ${current.rateLimits} 次，上一小时 ${previous.rateLimits} 次。`, value: current.rateLimits });
  const cutoffMs = deps.config.logRetentionDays > 0 ? now - deps.config.logRetentionDays * 86400000 : 0;
  const retentionSummary = deps.state.requestLogRetentionSummary(cutoffMs);
  return {
    now,
    window: { hours: window.hours, label: window.label, bucketMs: window.bucketMs },
    keys: { total: keys.length, healthy, cooldown, disabled, enabled: keys.length - disabled },
    retention: {
      days: deps.config.logRetentionDays,
      cutoffMs,
      cutoffAt: cutoffMs ? new Date(cutoffMs).toISOString() : null,
      ...retentionSummary
    },
    thresholds: { availableKeyMin: deps.config.alertAvailableKeyMin, failureRatePercent: deps.config.alertFailureRatePercent, rateLimitRatePercent: deps.config.alertRateLimitRatePercent },
    current,
    previous,
    alerts,
    trends,
    pool: deps.poolStats()
  };
}

export function buildConfigSummary(deps: AppDeps): Record<string, unknown> {
  return {
    listen: `${deps.config.host}:${deps.config.port}`,
    upstream: publicUrlTarget(deps.config.upstreamUrl) ?? deps.config.upstreamUrl,
    selectionStrategy: deps.config.selectionStrategy,
    allowedPaths: {
      count: deps.config.allowedPaths.length,
      preview: deps.config.allowedPaths.slice(0, 8)
    },
    resourceAffinity: deps.config.resourceAffinity,
    maxAttempts: deps.config.maxAttempts,
    attemptTimeoutMs: deps.config.attemptTimeoutMs,
    retryBackoffMs: deps.config.retryBackoffMs,
    logRetentionDays: deps.config.logRetentionDays,
    adminRequireHttps: deps.config.adminRequireHttps,
    adminSessionTtlSeconds: deps.config.adminSessionTtlSeconds,
    rawKeyDisplayAllowed: deps.config.allowRawKeyDisplay,
    state: {
      backend: 'sqlite',
      path: deps.config.statePath === ':memory:' ? ':memory:' : 'configured'
    },
    alerts: {
      availableKeyMin: deps.config.alertAvailableKeyMin,
      failureRatePercent: deps.config.alertFailureRatePercent,
      rateLimitRatePercent: deps.config.alertRateLimitRatePercent
    },
    webhook: {
      enabled: Boolean(deps.config.alertWebhookUrl),
      target: publicUrlTarget(deps.config.alertWebhookUrl),
      cooldownSeconds: deps.config.alertWebhookCooldownSeconds,
      maxAttempts: deps.config.alertWebhookMaxAttempts,
      signed: Boolean(deps.config.alertWebhookHmacSecret)
    }
  };
}

// Cache for Prometheus metrics — avoids expensive 5000-row query on every scrape
let metricsCache: { value: PrometheusOperationsMetrics; timestamp: number } | null = null;
const METRICS_CACHE_TTL = 30_000;

export function resetMetricsCache(): void { metricsCache = null; }

export function buildPrometheusOperationsMetrics(deps: AppDeps, observability: Record<string, unknown>): PrometheusOperationsMetrics {
  const now = Date.now();
  if (metricsCache && (now - metricsCache.timestamp) < METRICS_CACHE_TTL) {
    return metricsCache.value;
  }

  const keys = (observability.keys ?? {}) as Record<string, number>;
  const retention = (observability.retention ?? {}) as Record<string, number>;
  const alerts = Array.isArray(observability.alerts) ? observability.alerts : [];
  const keyStats = deps.state.listKeyStats();
  const logs = deps.state.listRequestLogs({ limit: 5000 });
  const logSummary = summarizeLogs(logs);
  const cooldownReasons: Record<string, number> = {};
  const upstreamErrors = { ...logSummary.upstreamErrors };
  for (const key of keyStats) {
    if (key.lastError) {
      const reason = lowCardinalityReason(key.lastError);
      upstreamErrors[reason] = (upstreamErrors[reason] ?? 0) + 1;
    }
    if (Number(key.cooldownUntil || 0) <= now) continue;
    const reason = lowCardinalityReason(key.cooldownReason);
    cooldownReasons[reason] = (cooldownReasons[reason] ?? 0) + 1;
  }
  const result: PrometheusOperationsMetrics = {
    totalKeys: Number(keys.total ?? 0),
    healthyKeys: Number(keys.healthy ?? 0),
    cooldownKeys: Number(keys.cooldown ?? 0),
    disabledKeys: Number(keys.disabled ?? 0),
    activeAlerts: alerts.length,
    requestLogsTotal: Number(retention.totalLogs ?? 0),
    requestLogsExpired: Number(retention.expiredLogs ?? 0),
    logRetentionDays: deps.config.logRetentionDays,
    requestStatusGroups: logSummary.statusGroups,
    requestLatencyP95Ms: logSummary.requestLatencyP95Ms,
    retriesTotal: keyStats.reduce((sum, key) => sum + Number(key.retryCount || 0), 0),
    upstreamErrors,
    cooldownReasons,
    poolStats: deps.poolStats()
  };
  metricsCache = { value: result, timestamp: now };
  return result;
}
