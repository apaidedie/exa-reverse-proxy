import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { KeyConfig } from './app.js';

export type AttemptRecord = {
  keyId: string;
  status: number | null;
  success: boolean;
  latencyMs: number;
  retry: boolean;
  reason: string;
};

export type RequestLogRecord = {
  requestId: string;
  tokenId: string | null;
  method: string;
  path: string;
  status: number;
  keyIds: string[];
  attempts: number;
  latencyMs: number;
  errorCode: string | null;
};

export type RequestLogQuery = {
  limit?: number;
  keyId?: string;
  path?: string;
  status?: string | number;
  from?: number;
  to?: number;
  errorOnly?: boolean;
};

export type AdminAuditQuery = {
  limit?: number;
  action?: string;
  success?: boolean;
  from?: number;
  to?: number;
};

export type KeyStats = {
  id: string;
  enabled: boolean;
  weight: number;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  rateLimitCount: number;
  timeoutCount: number;
  cooldownUntil: number;
  cooldownReason: string | null;
  lastStatus: number | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
};

export type RequestLog = Omit<RequestLogRecord, 'keyIds'> & { createdAt: number; keyIds: string[] };

export type KeyFailureSummary = {
  keyId: string;
  totalFailures: number;
  reasons: Record<string, number>;
  lastFailureAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  samples: RequestLog[];
};

export type RequestTrendBucket = {
  bucketStart: number;
  requests: number;
  success: number;
  failures: number;
  rateLimits: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
};

export type RequestLogRetentionSummary = {
  totalLogs: number;
  retainedLogs: number;
  expiredLogs: number;
  oldestLogAt: number | null;
  newestLogAt: number | null;
};

export type AdminAuditRecord = {
  actorTokenId: string | null;
  action: string;
  targetId?: string | null;
  success: boolean;
  detail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type AdminSessionRecord = {
  id: string;
  tokenId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
};

export type AdminAuditLog = Required<Omit<AdminAuditRecord, 'targetId' | 'detail' | 'ip' | 'userAgent'>> & {
  targetId: string | null;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
};

export type StateStore = {
  recordAttempt(record: AttemptRecord): void;
  setCooldown(keyId: string, untilMs: number, reason: string | null): void;
  setEnabled(keyId: string, enabled: boolean): void;
  listKeyStats(): KeyStats[];
  setAffinity(type: string, id: string, keyId: string): void;
  getAffinity(type: string, id: string): string | undefined;
  recordRequestLog(record: RequestLogRecord): void;
  listRequestLogs(query?: number | RequestLogQuery): RequestLog[];
  getRequestTrace(requestId: string): RequestLog[];
  keyFailureSummary(keyId: string, limit?: number): KeyFailureSummary;
  requestTrend(sinceMs: number, bucketMs: number): RequestTrendBucket[];
  requestLogRetentionSummary(cutoffMs: number): RequestLogRetentionSummary;
  pruneRequestLogs(olderThanMs: number): number;
  recordAdminAudit(record: AdminAuditRecord): void;
  listAdminAuditLogs(query: number | AdminAuditQuery): AdminAuditLog[];
  createAdminSession(record: AdminSessionRecord): void;
  getAdminSession(sessionId: string): AdminSessionRecord | undefined;
  touchAdminSession(sessionId: string, lastSeenAt: number): void;
  deleteAdminSession(sessionId: string): void;
  pruneAdminSessions(nowMs: number): number;
  close(): void;
};

function ensureParent(path: string): void {
  if (path === ':memory:') return;
  mkdirSync(dirname(path), { recursive: true });
}

function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

function normalizeLogQuery(query: number | RequestLogQuery | undefined): Required<RequestLogQuery> {
  if (typeof query === 'number' || query === undefined) {
    return { limit: query ?? 100, keyId: '', path: '', status: '', from: 0, to: 0, errorOnly: false };
  }
  return {
    limit: query.limit ?? 100,
    keyId: query.keyId ?? '',
    path: query.path ?? '',
    status: query.status ?? '',
    from: query.from ?? 0,
    to: query.to ?? 0,
    errorOnly: Boolean(query.errorOnly)
  };
}

function requestLogFromRow(row: any): RequestLog {
  return {
    requestId: row.request_id,
    tokenId: row.token_id,
    method: row.method,
    path: row.path,
    status: row.status,
    keyIds: JSON.parse(row.key_ids_json),
    attempts: row.attempts,
    latencyMs: row.latency_ms,
    errorCode: row.error_code,
    createdAt: row.created_at
  };
}

function normalizeAuditQuery(query: number | AdminAuditQuery): Required<AdminAuditQuery> {
  if (typeof query === 'number') {
    return { limit: query, action: '', success: undefined as unknown as boolean, from: 0, to: 0 };
  }
  return {
    limit: query.limit ?? 50,
    action: query.action ?? '',
    success: query.success as boolean,
    from: query.from ?? 0,
    to: query.to ?? 0
  };
}

function reasonForFailure(log: RequestLog): string {
  if (log.errorCode) return log.errorCode;
  if (log.status === 429) return 'rate_limit';
  if (log.status >= 500) return 'upstream_error';
  if (log.status >= 400) return 'client_status';
  return 'unknown_error';
}

function auditLogFromRow(row: any): AdminAuditLog {
  return {
    actorTokenId: row.actor_token_id,
    action: row.action,
    targetId: row.target_id,
    success: bool(row.success),
    detail: row.detail,
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at
  };
}

function adminSessionFromRow(row: any): AdminSessionRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at
  };
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)];
}

export function createStateStore(path: string, keys: KeyConfig[]): StateStore {
  ensureParent(path);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS key_stats (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      weight INTEGER NOT NULL,
      total_requests INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      rate_limit_count INTEGER NOT NULL DEFAULT 0,
      timeout_count INTEGER NOT NULL DEFAULT 0,
      cooldown_until INTEGER NOT NULL DEFAULT 0,
      cooldown_reason TEXT,
      last_status INTEGER,
      last_error TEXT,
      last_latency_ms INTEGER,
      last_success_at INTEGER,
      last_failure_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS resource_affinity (
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (resource_type, resource_id)
    );
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      token_id TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      key_ids_json TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      error_code TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_token_id TEXT,
      action TEXT NOT NULL,
      target_id TEXT,
      success INTEGER NOT NULL,
      detail TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs(created_at);
    CREATE INDEX IF NOT EXISTS request_logs_request_id_idx ON request_logs(request_id);
    CREATE INDEX IF NOT EXISTS request_logs_status_idx ON request_logs(status);
    CREATE INDEX IF NOT EXISTS request_logs_path_idx ON request_logs(path);
    CREATE INDEX IF NOT EXISTS request_logs_error_code_idx ON request_logs(error_code);
    CREATE INDEX IF NOT EXISTS admin_audit_logs_created_at_idx ON admin_audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS admin_audit_logs_action_idx ON admin_audit_logs(action);
    CREATE INDEX IF NOT EXISTS admin_audit_logs_actor_idx ON admin_audit_logs(actor_token_id);
    CREATE INDEX IF NOT EXISTS admin_sessions_expires_at_idx ON admin_sessions(expires_at);
  `);

  const upsertKey = db.prepare(`
    INSERT INTO key_stats (id, enabled, weight)
    VALUES (@id, @enabled, @weight)
    ON CONFLICT(id) DO UPDATE SET weight = excluded.weight
  `);
  for (const key of keys) upsertKey.run({ id: key.id, enabled: key.enabled ? 1 : 0, weight: key.weight });
  const keyIds = keys.map((key) => key.id);
  if (keyIds.length === 0) {
    db.prepare('DELETE FROM key_stats').run();
    db.prepare('DELETE FROM resource_affinity').run();
  } else {
    const placeholders = keyIds.map(() => '?').join(', ');
    db.prepare(`DELETE FROM key_stats WHERE id NOT IN (${placeholders})`).run(...keyIds);
    db.prepare(`DELETE FROM resource_affinity WHERE key_id NOT IN (${placeholders})`).run(...keyIds);
  }

  return {
    recordAttempt(record) {
      const now = Date.now();
      db.prepare(`
        UPDATE key_stats SET
          total_requests = total_requests + 1,
          success_count = success_count + @success,
          failure_count = failure_count + @failure,
          retry_count = retry_count + @retry,
          rate_limit_count = rate_limit_count + @rateLimit,
          timeout_count = timeout_count + @timeout,
          last_status = @status,
          last_error = @lastError,
          last_latency_ms = @latencyMs,
          last_success_at = CASE WHEN @success = 1 THEN @now ELSE last_success_at END,
          last_failure_at = CASE WHEN @failure = 1 THEN @now ELSE last_failure_at END
        WHERE id = @keyId
      `).run({
        keyId: record.keyId,
        success: record.success ? 1 : 0,
        failure: record.success ? 0 : 1,
        retry: record.retry ? 1 : 0,
        rateLimit: record.reason === 'rate_limit' ? 1 : 0,
        timeout: record.reason === 'timeout' ? 1 : 0,
        status: record.status,
        lastError: record.success ? null : record.reason,
        latencyMs: Math.round(record.latencyMs),
        now
      });
    },
    setCooldown(keyId, untilMs, reason) {
      db.prepare('UPDATE key_stats SET cooldown_until = ?, cooldown_reason = ? WHERE id = ?').run(untilMs, reason, keyId);
    },
    setEnabled(keyId, enabled) {
      db.prepare('UPDATE key_stats SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, keyId);
    },
    listKeyStats() {
      return db.prepare('SELECT * FROM key_stats ORDER BY id').all().map((row: any) => ({
        id: row.id,
        enabled: bool(row.enabled),
        weight: row.weight,
        totalRequests: row.total_requests,
        successCount: row.success_count,
        failureCount: row.failure_count,
        retryCount: row.retry_count,
        rateLimitCount: row.rate_limit_count,
        timeoutCount: row.timeout_count,
        cooldownUntil: row.cooldown_until,
        cooldownReason: row.cooldown_reason,
        lastStatus: row.last_status,
        lastError: row.last_error,
        lastLatencyMs: row.last_latency_ms,
        lastSuccessAt: row.last_success_at,
        lastFailureAt: row.last_failure_at
      }));
    },
    setAffinity(type, id, keyId) {
      db.prepare(`
        INSERT INTO resource_affinity (resource_type, resource_id, key_id, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(resource_type, resource_id) DO UPDATE SET key_id = excluded.key_id
      `).run(type, id, keyId, Date.now());
    },
    getAffinity(type, id) {
      const row = db.prepare('SELECT key_id AS keyId FROM resource_affinity WHERE resource_type = ? AND resource_id = ?').get(type, id) as { keyId: string } | undefined;
      return row?.keyId;
    },
    recordRequestLog(record) {
      db.prepare(`
        INSERT INTO request_logs (request_id, token_id, method, path, status, key_ids_json, attempts, latency_ms, error_code, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.requestId,
        record.tokenId,
        record.method,
        record.path,
        record.status,
        JSON.stringify(record.keyIds),
        record.attempts,
        Math.round(record.latencyMs),
        record.errorCode,
        Date.now()
      );
    },
    listRequestLogs(query) {
      const normalized = normalizeLogQuery(query);
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (normalized.from > 0) {
        clauses.push('created_at >= ?');
        params.push(normalized.from);
      }
      if (normalized.to > 0) {
        clauses.push('created_at <= ?');
        params.push(normalized.to);
      }
      if (normalized.path) {
        clauses.push('path LIKE ?');
        params.push(`%${normalized.path}%`);
      }
      if (normalized.keyId) {
        clauses.push('instr(key_ids_json, ?) > 0');
        params.push(JSON.stringify(normalized.keyId));
      }
      const status = String(normalized.status || '').trim().toLowerCase();
      if (status === 'success') clauses.push('status >= 200 AND status < 400 AND error_code IS NULL');
      if (status === 'error') clauses.push('(status >= 400 OR error_code IS NOT NULL)');
      if (/^[2-5]xx$/.test(status)) {
        const min = Number(status[0]) * 100;
        clauses.push('status >= ? AND status < ?');
        params.push(min, min + 100);
      }
      if (/^\d{3}$/.test(status)) {
        clauses.push('status = ?');
        params.push(Number(status));
      }
      if (normalized.errorOnly) clauses.push('(status >= 400 OR error_code IS NOT NULL)');
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.max(1, Math.min(Number(normalized.limit) || 100, 5000));
      return db
        .prepare(`SELECT * FROM request_logs ${where} ORDER BY id DESC LIMIT ?`)
        .all(...params, limit)
        .map(requestLogFromRow);
    },
    getRequestTrace(requestId) {
      return db
        .prepare('SELECT * FROM request_logs WHERE request_id = ? ORDER BY id ASC LIMIT 100')
        .all(String(requestId || ''))
        .map(requestLogFromRow);
    },
    keyFailureSummary(keyId, limit = 20) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
      const samples = db
        .prepare(`
          SELECT * FROM request_logs
          WHERE instr(key_ids_json, ?) > 0
            AND (status >= 400 OR error_code IS NOT NULL)
          ORDER BY id DESC
          LIMIT ?
        `)
        .all(JSON.stringify(String(keyId || '')), safeLimit)
        .map(requestLogFromRow);
      const reasons: Record<string, number> = {};
      for (const log of samples) {
        const reason = reasonForFailure(log);
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
      const latest = samples[0];
      return {
        keyId,
        totalFailures: samples.length,
        reasons,
        lastFailureAt: latest?.createdAt ?? null,
        lastStatus: latest?.status ?? null,
        lastError: latest ? reasonForFailure(latest) : null,
        samples
      };
    },
    requestTrend(sinceMs, bucketMs) {
      const safeBucket = Math.max(60000, Math.min(Math.round(bucketMs), 86400000));
      const now = Date.now();
      const start = Math.floor(Math.max(0, sinceMs) / safeBucket) * safeBucket;
      const bucketCount = Math.min(240, Math.max(1, Math.ceil((now - start) / safeBucket)));
      const buckets = new Map<number, RequestTrendBucket & { latencies: number[] }>();
      for (let index = 0; index < bucketCount; index += 1) {
        const bucketStart = start + index * safeBucket;
        buckets.set(bucketStart, { bucketStart, requests: 0, success: 0, failures: 0, rateLimits: 0, avgLatencyMs: 0, p95LatencyMs: 0, latencies: [] });
      }
      const rows = db.prepare('SELECT status, latency_ms, error_code, created_at FROM request_logs WHERE created_at >= ? ORDER BY created_at ASC').all(start) as any[];
      for (const row of rows) {
        const bucketStart = Math.floor(row.created_at / safeBucket) * safeBucket;
        if (!buckets.has(bucketStart)) buckets.set(bucketStart, { bucketStart, requests: 0, success: 0, failures: 0, rateLimits: 0, avgLatencyMs: 0, p95LatencyMs: 0, latencies: [] });
        const bucket = buckets.get(bucketStart)!;
        bucket.requests += 1;
        if (row.status >= 200 && row.status < 400 && !row.error_code) bucket.success += 1;
        if (row.status >= 400 || row.error_code) bucket.failures += 1;
        if (row.status === 429 || row.error_code === 'rate_limit') bucket.rateLimits += 1;
        bucket.latencies.push(row.latency_ms);
      }
      return [...buckets.values()]
        .sort((a, b) => a.bucketStart - b.bucketStart)
        .map((bucket) => {
          const avgLatencyMs = bucket.latencies.length ? Math.round(bucket.latencies.reduce((sum, value) => sum + value, 0) / bucket.latencies.length) : 0;
          const p95LatencyMs = percentile(bucket.latencies, 0.95);
          const { latencies: _latencies, ...publicBucket } = bucket;
          return { ...publicBucket, avgLatencyMs, p95LatencyMs };
        });
    },
    requestLogRetentionSummary(cutoffMs) {
      const row = db.prepare(`
        SELECT
          COUNT(*) AS total_logs,
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS retained_logs,
          SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END) AS expired_logs,
          MIN(created_at) AS oldest_log_at,
          MAX(created_at) AS newest_log_at
        FROM request_logs
      `).get(cutoffMs, cutoffMs) as any;
      return {
        totalLogs: Number(row.total_logs || 0),
        retainedLogs: Number(row.retained_logs || 0),
        expiredLogs: Number(row.expired_logs || 0),
        oldestLogAt: row.oldest_log_at ?? null,
        newestLogAt: row.newest_log_at ?? null
      };
    },
    pruneRequestLogs(olderThanMs) {
      const info = db.prepare('DELETE FROM request_logs WHERE created_at < ?').run(olderThanMs) as { changes: number };
      return info.changes;
    },
    recordAdminAudit(record) {
      db.prepare(`
        INSERT INTO admin_audit_logs (actor_token_id, action, target_id, success, detail, ip, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.actorTokenId,
        record.action,
        record.targetId ?? null,
        record.success ? 1 : 0,
        record.detail ?? null,
        record.ip ?? null,
        record.userAgent ?? null,
        Date.now()
      );
    },
    listAdminAuditLogs(query) {
      const normalized = normalizeAuditQuery(query);
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (normalized.from > 0) {
        clauses.push('created_at >= ?');
        params.push(normalized.from);
      }
      if (normalized.to > 0) {
        clauses.push('created_at <= ?');
        params.push(normalized.to);
      }
      if (normalized.action) {
        clauses.push('action LIKE ?');
        params.push(`%${normalized.action}%`);
      }
      if (typeof normalized.success === 'boolean') {
        clauses.push('success = ?');
        params.push(normalized.success ? 1 : 0);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.max(1, Math.min(Number(normalized.limit) || 50, 5000));
      return db
        .prepare(`SELECT * FROM admin_audit_logs ${where} ORDER BY id DESC LIMIT ?`)
        .all(...params, limit)
        .map(auditLogFromRow);
    },
    createAdminSession(record) {
      db.prepare(`
        INSERT INTO admin_sessions (id, token_id, created_at, expires_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          token_id = excluded.token_id,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          last_seen_at = excluded.last_seen_at
      `).run(record.id, record.tokenId, record.createdAt, record.expiresAt, record.lastSeenAt);
    },
    getAdminSession(sessionId) {
      const row = db.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(String(sessionId || '')) as any;
      return row ? adminSessionFromRow(row) : undefined;
    },
    touchAdminSession(sessionId, lastSeenAt) {
      db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, String(sessionId || ''));
    },
    deleteAdminSession(sessionId) {
      db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(String(sessionId || ''));
    },
    pruneAdminSessions(nowMs) {
      const info = db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(nowMs) as { changes: number };
      return info.changes;
    },
    close() {
      db.close();
    }
  };
}
