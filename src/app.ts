import Fastify, { type FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin.js';
import { resetMetricsCache } from './admin/observability.js';
import { createStateStore, type StateStore } from './state.js';
import { KeyScheduler } from './scheduler.js';
import { proxyHandler } from './proxy.js';
import { initUpstreamPool, closeUpstreamPool, getPoolStats, type PoolStats } from './upstream.js';
import { encrypt, decrypt } from './crypto.js';

export type KeyConfig = {
  id: string;
  value: string;
  weight: number;
  enabled: boolean;
};

export type ProxyConfig = {
  host: string;
  port: number;
  upstreamUrl: string;
  keys: KeyConfig[];
  encryptionSecret: string;
  proxyTokens: string[];
  adminTokens: string[];
  statePath: string;
  selectionStrategy: 'round_robin' | 'weighted_round_robin' | 'least_recently_used' | 'adaptive_weighted';
  maxAttempts: number;
  attemptTimeoutMs: number;
  retryBackoffMs: number[];
  failureThreshold: number;
  failureWindowSeconds: number;
  cooldownSeconds: number;
  rateLimitCooldownSeconds: number;
  creditsExhaustedCooldownSeconds: number;
  maxBodyBytes: number;
  allowedPaths: string[];
  resourceAffinity: boolean;
  logLevel: string;
  adminSessionTtlSeconds: number;
  adminLockoutMaxFailures: number;
  adminLockoutWindowSeconds: number;
  adminLockoutSeconds: number;
  adminRequireHttps: boolean;
  allowRawKeyDisplay: boolean;
  logRetentionDays: number;
  alertAvailableKeyMin: number;
  alertFailureRatePercent: number;
  alertRateLimitRatePercent: number;
  alertWebhookUrl: string | null;
  alertWebhookBearerToken: string | null;
  alertWebhookCooldownSeconds: number;
  alertWebhookHmacSecret: string | null;
  alertWebhookMaxAttempts: number;
  alertWebhookRetryBackoffMs: number;
  trendWindowHours: number;
  trustProxy: boolean | string | number;
  upstreamPoolConnections: number;
  affinityRetentionDays: number;
};

export type AppDeps = {
  config: ProxyConfig;
  state: StateStore;
  scheduler: KeyScheduler;
  poolStats: () => PoolStats | null;
};

function runLogRetention(deps: AppDeps): number {
  if (deps.config.logRetentionDays <= 0) return 0;
  const cutoff = Date.now() - deps.config.logRetentionDays * 86400000;
  const deleted = deps.state.pruneRequestLogs(cutoff);
  if (deleted > 0) {
    deps.state.recordAdminAudit({
      actorTokenId: null,
      action: 'auto_prune_logs',
      success: true,
      detail: `${deleted} rows before ${cutoff}`,
      ip: null,
      userAgent: null
    });
  }
  // Also prune expired resource affinity entries
  const affinityDays = deps.config.affinityRetentionDays > 0 ? deps.config.affinityRetentionDays : deps.config.logRetentionDays;
  const affinityCutoff = Date.now() - affinityDays * 86400000;
  deps.state.pruneAffinity(affinityCutoff);
  return deleted;
}

function startLogRetention(deps: AppDeps): ReturnType<typeof setInterval> | null {
  if (deps.config.logRetentionDays <= 0) return null;
  const timer = setInterval(() => runLogRetention(deps), 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

export async function buildApp(options: { config: ProxyConfig }): Promise<FastifyInstance> {
  resetMetricsCache();
  // Initialize upstream connection pool
  initUpstreamPool(options.config.upstreamUrl, { connections: options.config.upstreamPoolConnections || 128 });

  const app = Fastify({
    logger: options.config.logLevel === 'silent' ? false : { level: options.config.logLevel },
    bodyLimit: options.config.maxBodyBytes,
    trustProxy: options.config.trustProxy
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: options.config.maxBodyBytes }, (_request, body, done) => {
    done(null, body);
  });

  const state = createStateStore(options.config.statePath, options.config.keys);

  // Seed config keys with encrypted values into DB (first-time or env-based deployment)
  const secret = options.config.encryptionSecret;
  for (const key of options.config.keys) {
    if (key.value && secret) {
      state.upsertKey(key.id, encrypt(key.value, secret), key.weight, key.enabled);
    }
  }

  // Load all keys from DB (source of truth) and decrypt values
  const dbKeys = state.listPersistentKeys();
  const configKeys: KeyConfig[] = dbKeys.map((dk) => ({
    id: dk.id,
    value: secret && dk.value ? decrypt(dk.value, secret) : dk.value,
    weight: dk.weight,
    enabled: dk.enabled
  }));

  if (configKeys.length === 0) {
    app.log.warn('No Exa API keys configured. Proxy requests will return 503 until keys are added via admin API (POST /_proxy/keys).');
  }

  // Update config.keys to reflect DB state (runtime snapshot)
  options.config.keys = configKeys;

  const scheduler = new KeyScheduler(configKeys, options.config.selectionStrategy);
  scheduler.updateAdaptiveStats(state.listKeyStats());
  const deps = { config: options.config, state, scheduler, poolStats: getPoolStats };
  runLogRetention(deps);
  const logRetentionTimer = startLogRetention(deps);

  // Unauthenticated liveness probe for load balancers and orchestrators
  app.get('/_proxy/live', async () => ({ ok: true, keys: configKeys.length }));

  app.addHook('onClose', async () => {
    if (logRetentionTimer) clearInterval(logRetentionTimer);
    closeUpstreamPool();
    state.close();
  });

  await registerAdminRoutes(app, deps);

  app.route({
    method: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    url: '/*',
    handler: async (request, reply) => proxyHandler(request, reply, deps)
  });

  return app;
}
