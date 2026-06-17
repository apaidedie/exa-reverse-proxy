import type { ProxyConfig } from './app.js';
import { readFileSync } from 'node:fs';

type Env = Record<string, string | undefined>;

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readNumber(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function readOptionalString(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function resolveSecret(raw: string, env: Env): string {
  const match = raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!match) return raw;
  const resolved = env[match[1]];
  if (!resolved) throw new Error(`Missing environment variable for EXA_KEYS entry: ${match[1]}`);
  return resolved;
}

function normalizeFileKey(line: string): string | null {
  let value = line.trim();
  if (!value || value.startsWith('#')) return null;
  if (value.startsWith('export ')) value = value.slice('export '.length).trim();
  if (value.includes('=')) value = value.split('=', 2)[1].trim();
  value = value.replace(/^['"]|['"]$/g, '').trim();
  return value || null;
}

function parseFileKeyEntry(line: string, env: Env): { id: string | null; value: string; weight: number } | null {
  const normalized = normalizeFileKey(line);
  if (!normalized) return null;

  const parts = normalized.split(':');
  if (parts.length === 1) return { id: null, value: resolveSecret(normalized, env), weight: 1 };
  if (parts.length !== 3) throw new Error(`Invalid EXA_KEYS_FILE entry: ${normalized}`);

  const [id, valueRaw, weightRaw] = parts;
  const value = resolveSecret(valueRaw, env);
  const weight = Number(weightRaw);
  if (!id || !value || !Number.isInteger(weight) || weight < 1) {
    throw new Error(`Invalid EXA_KEYS_FILE entry: ${normalized}`);
  }
  return { id, value, weight };
}

function parseKeysFile(path: string | undefined, env: Env, offset: number, usedValues: Set<string>, usedIds: Set<string>): ProxyConfig['keys'] {
  if (!path) return [];
  const filePath = resolveSecret(path, env);
  const keys: ProxyConfig['keys'] = [];
  let cursor = offset + 1;

  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const entry = parseFileKeyEntry(line, env);
    if (!entry || usedValues.has(entry.value)) continue;
    usedValues.add(entry.value);

    if (entry.id) {
      if (usedIds.has(entry.id)) throw new Error(`Duplicate EXA key id in EXA_KEYS_FILE: ${entry.id}`);
      usedIds.add(entry.id);
      keys.push({ id: entry.id, value: entry.value, weight: entry.weight, enabled: true });
      continue;
    }

    let id = `exa_${String(cursor).padStart(4, '0')}`;
    while (usedIds.has(id)) {
      cursor += 1;
      id = `exa_${String(cursor).padStart(4, '0')}`;
    }
    usedIds.add(id);
    cursor += 1;
    keys.push({ id, value: entry.value, weight: 1, enabled: true });
  }

  return keys;
}

function parseKeys(raw: string | undefined, env: Env): ProxyConfig['keys'] {
  return splitCsv(raw).map((entry) => {
    const parts = entry.split(':');
    if (parts.length !== 3) throw new Error(`Invalid EXA_KEYS entry: ${entry}`);
    const [id, valueRaw, weightRaw] = parts;
    const value = resolveSecret(valueRaw, env);
    const weight = Number(weightRaw);
    if (!id || !value || !Number.isInteger(weight) || weight < 1) throw new Error(`Invalid EXA_KEYS entry: ${entry}`);
    return { id, value, weight, enabled: true };
  });
}

function parseConfiguredKeys(env: Env): ProxyConfig['keys'] {
  const explicitKeys = parseKeys(env.EXA_KEYS, env);
  const usedValues = new Set(explicitKeys.map((key) => key.value));
  const usedIds = new Set(explicitKeys.map((key) => key.id));
  return [
    ...explicitKeys,
    ...parseKeysFile(env.EXA_KEYS_FILE, env, explicitKeys.length, usedValues, usedIds)
  ];
}

function parseStrategy(raw: string | undefined): ProxyConfig['selectionStrategy'] {
  if (!raw) return 'weighted_round_robin';
  if (raw === 'round_robin' || raw === 'weighted_round_robin' || raw === 'least_recently_used' || raw === 'adaptive_weighted') return raw;
  throw new Error(`Invalid EXA_SELECTION_STRATEGY: ${raw}`);
}

function readNumberList(env: Env, name: string, fallback: number[]): number[] {
  const values = splitCsv(env[name]).map(Number);
  if (values.length === 0) return fallback;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error(`${name} must be a comma-separated list of non-negative numbers`);
  return values;
}

export function loadConfigFromEnv(env: Env = process.env): ProxyConfig {
  const proxyTokens = splitCsv(env.EXA_PROXY_TOKENS);
  if (proxyTokens.length === 0) throw new Error('EXA_PROXY_TOKENS is required');
  if (proxyTokens.some(t => t.length < 16)) {
    throw new Error('All proxy tokens must be at least 16 characters for security');
  }

  const adminTokens = splitCsv(env.EXA_ADMIN_TOKENS);
  if (adminTokens.some(t => t.length < 16)) {
    throw new Error('All admin tokens must be at least 16 characters for security');
  }

  const keys = parseConfiguredKeys(env);
  // Keys may be empty at config load time — they can be loaded from SQLite DB at startup
  // or added later via admin API. The "at least one key" check is in buildApp().

  const upstreamUrl = env.EXA_UPSTREAM_URL ?? 'https://api.exa.ai';
  try {
    new URL(upstreamUrl);
  } catch {
    throw new Error(`Invalid EXA_UPSTREAM_URL: ${upstreamUrl}`);
  }

  const allowedPaths = splitCsv(env.EXA_ALLOWED_PATHS);

  return {
    host: env.HOST ?? '0.0.0.0',
    port: readNumber(env, 'PORT', 8787),
    upstreamUrl,
    keys,
    encryptionSecret: env.EXA_KEYS_ENCRYPTION_SECRET ?? '',
    proxyTokens,
    adminTokens,
    statePath: env.EXA_STATE_PATH ?? './exa-proxy.sqlite',
    selectionStrategy: parseStrategy(env.EXA_SELECTION_STRATEGY),
    maxAttempts: readNumber(env, 'EXA_MAX_ATTEMPTS', 3),
    attemptTimeoutMs: readNumber(env, 'EXA_ATTEMPT_TIMEOUT_MS', 30000),
    retryBackoffMs: readNumberList(env, 'EXA_RETRY_BACKOFF_MS', [200, 600, 1500]),
    failureThreshold: readNumber(env, 'EXA_FAILURE_THRESHOLD', 3),
    failureWindowSeconds: readNumber(env, 'EXA_FAILURE_WINDOW_SECONDS', 60),
    cooldownSeconds: readNumber(env, 'EXA_COOLDOWN_SECONDS', 120),
    rateLimitCooldownSeconds: readNumber(env, 'EXA_RATE_LIMIT_COOLDOWN_SECONDS', 300),
    creditsExhaustedCooldownSeconds: readNumber(env, 'EXA_CREDITS_EXHAUSTED_COOLDOWN_SECONDS', 600),
    maxBodyBytes: readNumber(env, 'EXA_MAX_BODY_BYTES', 20971520),
    allowedPaths: allowedPaths.length > 0 ? allowedPaths : ['/**'],
    resourceAffinity: env.EXA_RESOURCE_AFFINITY !== 'false',
    logLevel: env.LOG_LEVEL ?? 'info',
    adminSessionTtlSeconds: readNumber(env, 'EXA_ADMIN_SESSION_TTL_SECONDS', 604800),
    adminLockoutMaxFailures: readNumber(env, 'EXA_ADMIN_LOCKOUT_MAX_FAILURES', 5),
    adminLockoutWindowSeconds: readNumber(env, 'EXA_ADMIN_LOCKOUT_WINDOW_SECONDS', 300),
    adminLockoutSeconds: readNumber(env, 'EXA_ADMIN_LOCKOUT_SECONDS', 900),
    adminRequireHttps: env.EXA_ADMIN_REQUIRE_HTTPS === 'true',
    allowRawKeyDisplay: env.EXA_ADMIN_ALLOW_RAW_KEY_DISPLAY === 'true',
    logRetentionDays: readNumber(env, 'EXA_LOG_RETENTION_DAYS', 14),
    alertAvailableKeyMin: readNumber(env, 'EXA_ALERT_AVAILABLE_KEY_MIN', 1),
    alertFailureRatePercent: readNumber(env, 'EXA_ALERT_FAILURE_RATE_PERCENT', 10),
    alertRateLimitRatePercent: readNumber(env, 'EXA_ALERT_RATE_LIMIT_RATE_PERCENT', 20),
    alertWebhookUrl: readOptionalString(env, 'EXA_ALERT_WEBHOOK_URL'),
    alertWebhookBearerToken: readOptionalString(env, 'EXA_ALERT_WEBHOOK_BEARER_TOKEN'),
    alertWebhookCooldownSeconds: readNumber(env, 'EXA_ALERT_WEBHOOK_COOLDOWN_SECONDS', 300),
    alertWebhookHmacSecret: readOptionalString(env, 'EXA_ALERT_WEBHOOK_HMAC_SECRET'),
    alertWebhookMaxAttempts: Math.max(1, Math.round(readNumber(env, 'EXA_ALERT_WEBHOOK_MAX_ATTEMPTS', 1))),
    alertWebhookRetryBackoffMs: readNumber(env, 'EXA_ALERT_WEBHOOK_RETRY_BACKOFF_MS', 250),
    trendWindowHours: readNumber(env, 'EXA_TREND_WINDOW_HOURS', 24),
    trustProxy: env.EXA_TRUST_PROXY === 'true' ? true : env.EXA_TRUST_PROXY === 'false' ? false : (env.EXA_TRUST_PROXY ? env.EXA_TRUST_PROXY : false),
    upstreamPoolConnections: readNumber(env, 'EXA_UPSTREAM_POOL_CONNECTIONS', 128),
    affinityRetentionDays: readNumber(env, 'EXA_AFFINITY_RETENTION_DAYS', 7)
  };
}
