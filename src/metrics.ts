import type { KeyStats } from './state.js';

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export type PrometheusOperationsMetrics = {
  totalKeys: number;
  healthyKeys: number;
  cooldownKeys: number;
  disabledKeys: number;
  activeAlerts: number;
  requestLogsTotal: number;
  requestLogsExpired: number;
  logRetentionDays: number;
  requestStatusGroups?: Record<string, number>;
  requestLatencyP95Ms?: number;
  retriesTotal?: number;
  upstreamErrors?: Record<string, number>;
  cooldownReasons?: Record<string, number>;
  poolStats?: { connected: number; free: number; queued: number; running: number; pending: number; size: number } | null;
};

export function renderPrometheusKeyMetrics(rows: KeyStats[], operations?: PrometheusOperationsMetrics): string {
  const lines = [
    '# HELP exa_proxy_requests_total Total upstream attempts by key',
    '# TYPE exa_proxy_requests_total counter',
    '# HELP exa_proxy_key_failures_total Failed upstream attempts by key',
    '# TYPE exa_proxy_key_failures_total counter'
  ];
  for (const row of rows) {
    const id = escapeLabel(row.id);
    lines.push(`exa_proxy_requests_total{key_id="${id}"} ${row.totalRequests}`);
    lines.push(`exa_proxy_key_success_total{key_id="${id}"} ${row.successCount}`);
    lines.push(`exa_proxy_key_failures_total{key_id="${id}"} ${row.failureCount}`);
    lines.push(`exa_proxy_key_rate_limits_total{key_id="${id}"} ${row.rateLimitCount}`);
    lines.push(`exa_proxy_key_credits_exhausted_total{key_id="${id}"} ${row.creditsExhaustedCount}`);
    lines.push(`exa_proxy_key_cooldown_until_ms{key_id="${id}"} ${row.cooldownUntil}`);
  }
  if (operations) {
    lines.push(
      '# HELP exa_proxy_keys_total Configured upstream keys',
      '# TYPE exa_proxy_keys_total gauge',
      `exa_proxy_keys_total ${operations.totalKeys}`,
      '# HELP exa_proxy_keys_healthy Upstream keys currently enabled and outside cooldown',
      '# TYPE exa_proxy_keys_healthy gauge',
      `exa_proxy_keys_healthy ${operations.healthyKeys}`,
      '# HELP exa_proxy_keys_cooldown Upstream keys currently in cooldown',
      '# TYPE exa_proxy_keys_cooldown gauge',
      `exa_proxy_keys_cooldown ${operations.cooldownKeys}`,
      '# HELP exa_proxy_keys_disabled Upstream keys disabled by configuration or operator action',
      '# TYPE exa_proxy_keys_disabled gauge',
      `exa_proxy_keys_disabled ${operations.disabledKeys}`,
      '# HELP exa_proxy_alerts_active Active admin-console alerts',
      '# TYPE exa_proxy_alerts_active gauge',
      `exa_proxy_alerts_active ${operations.activeAlerts}`,
      '# HELP exa_proxy_request_logs_total Request logs currently stored',
      '# TYPE exa_proxy_request_logs_total gauge',
      `exa_proxy_request_logs_total ${operations.requestLogsTotal}`,
      '# HELP exa_proxy_request_logs_expired Request logs older than the configured retention cutoff',
      '# TYPE exa_proxy_request_logs_expired gauge',
      `exa_proxy_request_logs_expired ${operations.requestLogsExpired}`,
      '# HELP exa_proxy_log_retention_days Configured request-log retention window in days',
      '# TYPE exa_proxy_log_retention_days gauge',
      `exa_proxy_log_retention_days ${operations.logRetentionDays}`
    );
    const statusGroups = operations.requestStatusGroups ?? {};
    lines.push(
      '# HELP exa_proxy_request_status_group_total Stored request logs grouped by status class',
      '# TYPE exa_proxy_request_status_group_total counter'
    );
    for (const group of ['2xx', '3xx', '4xx', '5xx', 'other']) {
      lines.push(`exa_proxy_request_status_group_total{status_group="${group}"} ${Number(statusGroups[group] ?? 0)}`);
    }
    lines.push(
      '# HELP exa_proxy_request_latency_p95_ms P95 latency from stored request logs',
      '# TYPE exa_proxy_request_latency_p95_ms gauge',
      `exa_proxy_request_latency_p95_ms ${Number(operations.requestLatencyP95Ms ?? 0)}`,
      '# HELP exa_proxy_retries_total Total retry attempts recorded by key stats',
      '# TYPE exa_proxy_retries_total counter',
      `exa_proxy_retries_total ${Number(operations.retriesTotal ?? 0)}`,
      '# HELP exa_proxy_upstream_error_total Stored request-log errors grouped by low-cardinality reason',
      '# TYPE exa_proxy_upstream_error_total counter'
    );
    for (const [reason, count] of Object.entries(operations.upstreamErrors ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`exa_proxy_upstream_error_total{reason="${escapeLabel(reason)}"} ${Number(count)}`);
    }
    lines.push(
      '# HELP exa_proxy_cooldown_reason_total Current key cooldowns grouped by low-cardinality reason',
      '# TYPE exa_proxy_cooldown_reason_total gauge'
    );
    for (const [reason, count] of Object.entries(operations.cooldownReasons ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`exa_proxy_cooldown_reason_total{reason="${escapeLabel(reason)}"} ${Number(count)}`);
    }
    const pool = operations.poolStats;
    if (pool) {
      lines.push(
        '# HELP exa_proxy_pool_connected Upstream pool connected sockets',
        '# TYPE exa_proxy_pool_connected gauge',
        `exa_proxy_pool_connected ${pool.connected}`,
        '# HELP exa_proxy_pool_free Upstream pool free (idle) connections',
        '# TYPE exa_proxy_pool_free gauge',
        `exa_proxy_pool_free ${pool.free}`,
        '# HELP exa_proxy_pool_queued Upstream pool queued requests',
        '# TYPE exa_proxy_pool_queued gauge',
        `exa_proxy_pool_queued ${pool.queued}`,
        '# HELP exa_proxy_pool_running Upstream pool running requests',
        '# TYPE exa_proxy_pool_running gauge',
        `exa_proxy_pool_running ${pool.running}`,
        '# HELP exa_proxy_pool_pending Upstream pool pending requests',
        '# TYPE exa_proxy_pool_pending gauge',
        `exa_proxy_pool_pending ${pool.pending}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
