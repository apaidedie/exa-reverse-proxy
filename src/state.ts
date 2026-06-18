import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { KeyConfig } from './app.js';
import { percentile } from './util/shared.js';

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
  value: string | null;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  rateLimitCount: number;
  timeoutCount: number;
  creditsExhaustedCount: number;
  cooldownUntil: number;
  cooldownReason: string | null;
  lastStatus: number | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
};

export type PersistentKey = {
  id: string;
  value: string;
  weight: number;
  enabled: boolean;
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
  upsertKey(id: string, encryptedValue: string, weight: number, enabled: boolean): void;
  deleteKey(id: string): void;
  listPersistentKeys(): PersistentKey[];
  getKeyValue(id: string): string | null;
  keyCount(): number;
  setAffinity(type: string, id: string, keyId: string): void;
  getAffinity(type: string, id: string): string | undefined;
  pruneAffinity(olderThanMs: number): number;
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
  runTransaction(fn: () => void): void;
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
    CREATE INDEX IF NOT EXISTS resource_affinity_created_at_idx ON resource_affinity(created_at);
  `);

  // Safe migration: add credits_exhausted_count column if missing (existing databases)
  const columns = (db.prepare("PRAGMA table_info(key_stats)").all() as Array<{ name: string }>);
  if (!columns.some((col) => col.name === 'credits_exhausted_count')) {
    db.exec('ALTER TABLE key_stats ADD COLUMN credits_exhausted_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some((col) => col.name === 'value')) {
    db.exec('ALTER TABLE key_stats ADD COLUMN value TEXT');
  }

  // --- Pre-prepare all static SQL statements ---
  const stmtUpsertKey = db.prepare(`
    INSERT INTO key_stats (id, enabled, weight)
    VALUES (@id, @enabled, @weight)
    ON CONFLICT(id) DO UPDATE SET weight = excluded.weight
  `);
  const stmtUpsertKeyWithValue = db.prepare(`
    INSERT INTO key_stats (id, enabled, weight, value)
    VALUES (@id, @enabled, @weight, @value)
    ON CONFLICT(id) DO UPDATE SET weight = excluded.weight, value = COALESCE(excluded.value, key_stats.value)
  `);
  const stmtDeleteKey = db.prepare('DELETE FROM key_stats WHERE id = ?');
  const stmtDeleteAffinityForKey = db.prepare('DELETE FROM resource_affinity WHERE key_id = ?');
  const stmtListPersistentKeys = db.prepare('SELECT id, value, weight, enabled FROM key_stats WHERE value IS NOT NULL ORDER BY id');
  const stmtGetKeyValue = db.prepare('SELECT value FROM key_stats WHERE id = ?');
  const stmtCountKeys = db.prepare('SELECT COUNT(*) AS count FROM key_stats');
  const stmtRecordAttempt = db.prepare(`
    UPDATE key_stats SET
      total_requests = total_requests + 1,
      success_count = success_count + @success,
      failure_count = failure_count + @failure,
      retry_count = retry_count + @retry,
      rate_limit_count = rate_limit_count + @rateLimit,
      timeout_count = timeout_count + @timeout,
      credits_exhausted_count = credits_exhausted_count + @creditsExhausted,
      last_status = @status,
      last_error = @lastError,
      last_latency_ms = @latencyMs,
      last_success_at = CASE WHEN @success = 1 THEN @now ELSE last_success_at END,
      last_failure_at = CASE WHEN @failure = 1 THEN @now ELSE last_failure_at END
    WHERE id = @keyId
  `);
  const stmtSetCooldown = db.prepare('UPDATE key_stats SET cooldown_until = ?, cooldown_reason = ? WHERE id = ?');
  const stmtSetEnabled = db.prepare('UPDATE key_stats SET enabled = ? WHERE id = ?');
  const stmtListKeyStats = db.prepare('SELECT * FROM key_stats ORDER BY id');
  const stmtSetAffinity = db.prepare(`
    INSERT INTO resource_affinity (resource_type, resource_id, key_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(resource_type, resource_id) DO UPDATE SET key_id = excluded.key_id, created_at = excluded.created_at
  `);
  const stmtGetAffinity = db.prepare('SELECT key_id AS keyId FROM resource_affinity WHERE resource_type = ? AND resource_id = ?');
  const stmtPruneAffinity = db.prepare('DELETE FROM resource_affinity WHERE created_at < ?');
  const stmtInsertRequestLog = db.prepare(`
    INSERT INTO request_logs (request_id, token_id, method, path, status, key_ids_json, attempts, latency_ms, error_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtGetRequestTrace = db.prepare('SELECT * FROM request_logs WHERE request_id = ? ORDER BY id ASC LIMIT 100');
  const stmtRetentionSummary = db.prepare(`
    SELECT
      COUNT(*) AS total_logs,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS retained_logs,
      SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END) AS expired_logs,
      MIN(created_at) AS oldest_log_at,
      MAX(created_at) AS newest_log_at
    FROM request_logs
  `);
  const stmtPruneRequestLogs = db.prepare('DELETE FROM request_logs WHERE created_at < ?');
  const stmtInsertAudit = db.prepare(`
    INSERT INTO admin_audit_logs (actor_token_id, action, target_id, success, detail, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtUpsertSession = db.prepare(`
    INSERT INTO admin_sessions (id, token_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      token_id = excluded.token_id,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      last_seen_at = excluded.last_seen_at
  `);
  const stmtGetSession = db.prepare('SELECT * FROM admin_sessions WHERE id = ?');
  const stmtTouchSession = db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?');
  const stmtDeleteSession = db.prepare('DELETE FROM admin_sessions WHERE id = ?');
  const stmtPruneSessions = db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?');

  // Initialize keys: seed config keys into DB (DB is source of truth, never delete existing DB keys)
  for (const key of keys) {
    stmtUpsertKey.run({ id: key.id, enabled: key.enabled ? 1 : 0, weight: key.weight });
  }

  function keyStatsFromRow(row: any): KeyStats {
    return {
      id: row.id,
      enabled: bool(row.enabled),
      weight: row.weight,
      value: row.value ?? null,
      totalRequests: row.total_requests,
      successCount: row.success_count,
      failureCount: row.failure_count,
      retryCount: row.retry_count,
      rateLimitCount: row.rate_limit_count,
      timeoutCount: row.timeout_count,
      creditsExhaustedCount: row.credits_exhausted_count || 0,
      cooldownUntil: row.cooldown_until,
      cooldownReason: row.cooldown_reason,
      lastStatus: row.last_status,
      lastError: row.last_error,
      lastLatencyMs: row.last_latency_ms,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at
    };
  }

  // Helper: build an exact JSON key match pattern to avoid substring false positives.
  // key_ids_json stores arrays like ["exa_0001","exa_0002"], so we match on `"keyId"` with surrounding quotes.
  function keyIdMatchPattern(keyId: string): string {
    return `%"${keyId.replace(/[\\"]/g, '\\$&')}"%`;
  }

  return {
    recordAttempt(record) {
      const now = Date.now();
      stmtRecordAttempt.run({
        keyId: record.keyId,
        success: record.success ? 1 : 0,
        failure: record.success ? 0 : 1,
        retry: record.retry ? 1 : 0,
        rateLimit: record.reason === 'rate_limit' ? 1 : 0,
        timeout: record.reason === 'timeout' ? 1 : 0,
        creditsExhausted: record.reason === 'credits_exhausted' ? 1 : 0,
        status: record.status,
        lastError: record.success ? null : record.reason,
        latencyMs: Math.round(record.latencyMs),
        now
      });
    },
    setCooldown(keyId, untilMs, reason) {
      stmtSetCooldown.run(untilMs, reason, keyId);
    },
    setEnabled(keyId, enabled) {
      stmtSetEnabled.run(enabled ? 1 : 0, keyId);
    },
    listKeyStats() {
      return stmtListKeyStats.all().map(keyStatsFromRow);
    },
    upsertKey(id, encryptedValue, weight, enabled) {
      stmtUpsertKeyWithValue.run({ id, enabled: enabled ? 1 : 0, weight, value: encryptedValue });
    },
    deleteKey(id) {
      db.transaction(() => {
        stmtDeleteAffinityForKey.run(id);
        stmtDeleteKey.run(id);
      })();
    },
    listPersistentKeys() {
      return stmtListPersistentKeys.all().map((row: any) => ({
        id: row.id,
        value: row.value,
        weight: row.weight,
        enabled: bool(row.enabled)
      }));
    },
    getKeyValue(id) {
      const row = stmtGetKeyValue.get(id) as { value: string | null } | undefined;
      return row?.value ?? null;
    },
    keyCount() {
      const row = stmtCountKeys.get() as { count: number };
      return row.count;
    },
    setAffinity(type, id, keyId) {
      stmtSetAffinity.run(type, id, keyId, Date.now());
    },
    getAffinity(type, id) {
      const row = stmtGetAffinity.get(type, id) as { keyId: string } | undefined;
      return row?.keyId;
    },
    pruneAffinity(olderThanMs) {
      const info = stmtPruneAffinity.run(olderThanMs) as { changes: number };
      return info.changes;
    },
    recordRequestLog(record) {
      stmtInsertRequestLog.run(
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
        clauses.push('key_ids_json LIKE ?');
        params.push(keyIdMatchPattern(normalized.keyId));
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
      return stmtGetRequestTrace.all(String(requestId || '')).map(requestLogFromRow);
    },
    keyFailureSummary(keyId, limit = 20) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
      const samples = db
        .prepare(`
          SELECT * FROM request_logs
          WHERE key_ids_json LIKE ?
            AND (status >= 400 OR error_code IS NOT NULL)
          ORDER BY id DESC
          LIMIT ?
        `)
        .all(keyIdMatchPattern(String(keyId || '')), safeLimit)
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

      // Pre-initialize all expected buckets
      const buckets = new Map<number, RequestTrendBucket & { latencies: number[] }>();
      for (let index = 0; index < bucketCount; index += 1) {
        const bucketStart = start + index * safeBucket;
        buckets.set(bucketStart, { bucketStart, requests: 0, success: 0, failures: 0, rateLimits: 0, avgLatencyMs: 0, p95LatencyMs: 0, latencies: [] });
      }

      // Use SQLite GROUP BY for aggregate metrics (count, sum, avg)
      const aggRows = db.prepare(`
        SELECT
          (created_at / ?) * ? AS bucket_start,
          COUNT(*) AS requests,
          SUM(CASE WHEN status >= 200 AND status < 400 AND error_code IS NULL THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN status >= 400 OR error_code IS NOT NULL THEN 1 ELSE 0 END) AS failures,
          SUM(CASE WHEN status = 429 OR error_code = 'rate_limit' THEN 1 ELSE 0 END) AS rate_limits,
          ROUND(AVG(latency_ms)) AS avg_latency_ms
        FROM request_logs
        WHERE created_at >= ?
        GROUP BY bucket_start
        ORDER BY bucket_start ASC
      `).all(safeBucket, safeBucket, start) as Array<{ bucket_start: number; requests: number; success: number; failures: number; rate_limits: number; avg_latency_ms: number }>;

      for (const row of aggRows) {
        const bucketStart = Number(row.bucket_start);
        if (!buckets.has(bucketStart)) {
          buckets.set(bucketStart, { bucketStart, requests: 0, success: 0, failures: 0, rateLimits: 0, avgLatencyMs: 0, p95LatencyMs: 0, latencies: [] });
        }
        const bucket = buckets.get(bucketStart)!;
        bucket.requests = Number(row.requests);
        bucket.success = Number(row.success);
        bucket.failures = Number(row.failures);
        bucket.rateLimits = Number(row.rate_limits);
        bucket.avgLatencyMs = Math.round(Number(row.avg_latency_ms || 0));
      }

      // Fetch only latency values for P95 calculation (still needed in JS)
      const latencyRows = db.prepare('SELECT latency_ms, created_at FROM request_logs WHERE created_at >= ?').all(start) as Array<{ latency_ms: number; created_at: number }>;
      for (const row of latencyRows) {
        const bucketStart = Math.floor(row.created_at / safeBucket) * safeBucket;
        const bucket = buckets.get(bucketStart);
        if (bucket) bucket.latencies.push(row.latency_ms);
      }

      return [...buckets.values()]
        .sort((a, b) => a.bucketStart - b.bucketStart)
        .map((bucket) => {
          const p95LatencyMs = percentile(bucket.latencies, 0.95);
          const { latencies: _latencies, ...publicBucket } = bucket;
          return { ...publicBucket, p95LatencyMs };
        });
    },
    requestLogRetentionSummary(cutoffMs) {
      const row = stmtRetentionSummary.get(cutoffMs, cutoffMs) as any;
      return {
        totalLogs: Number(row.total_logs || 0),
        retainedLogs: Number(row.retained_logs || 0),
        expiredLogs: Number(row.expired_logs || 0),
        oldestLogAt: row.oldest_log_at ?? null,
        newestLogAt: row.newest_log_at ?? null
      };
    },
    pruneRequestLogs(olderThanMs) {
      const info = stmtPruneRequestLogs.run(olderThanMs) as { changes: number };
      return info.changes;
    },
    recordAdminAudit(record) {
      stmtInsertAudit.run(
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
      stmtUpsertSession.run(record.id, record.tokenId, record.createdAt, record.expiresAt, record.lastSeenAt);
    },
    getAdminSession(sessionId) {
      const row = stmtGetSession.get(String(sessionId || '')) as any;
      return row ? adminSessionFromRow(row) : undefined;
    },
    touchAdminSession(sessionId, lastSeenAt) {
      stmtTouchSession.run(lastSeenAt, String(sessionId || ''));
    },
    deleteAdminSession(sessionId) {
      stmtDeleteSession.run(String(sessionId || ''));
    },
    pruneAdminSessions(nowMs) {
      const info = stmtPruneSessions.run(nowMs) as { changes: number };
      return info.changes;
    },
    runTransaction(fn: () => void): void {
      db.transaction(fn)();
    },
    close() {
      db.close();
    }
  };
}
