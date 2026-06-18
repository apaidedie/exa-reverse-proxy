import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './testConfig.js';
import { createFakeExa } from './helpers/fakeExa.js';

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
  vi.useRealTimers();
});

describe('admin api and ui', () => {
  it('keeps the admin UI in a separate static resource', () => {
    const adminSource = readFileSync('src/admin.ts', 'utf8');
    const uiSource = readFileSync('src/admin-ui/index.html', 'utf8');

    expect(adminSource).not.toContain('const adminUi = `<!doctype html>');
    expect(uiSource).toContain('<!doctype html>');
    expect(uiSource).toContain('workbench-shell');
    expect(uiSource).toContain('primary-workspace');
  });

  it('splits the admin UI into separate HTML, CSS, and JavaScript assets', async () => {
    const uiSource = readFileSync('src/admin-ui/index.html', 'utf8');
    const cssPath = 'src/admin-ui/admin.css';
    const jsPath = 'src/admin-ui/admin.js';

    expect(existsSync(cssPath)).toBe(true);
    expect(existsSync(jsPath)).toBe(true);
    expect(uiSource).toContain('<link rel="stylesheet" href="/_proxy/ui/admin.css">');
    expect(uiSource).toContain('<script type="module" src="/_proxy/ui/admin.js"></script>');
    expect(uiSource).not.toContain('<style>');
    expect(uiSource).not.toContain('<script>');
    expect(readFileSync(cssPath, 'utf8')).toContain('.console-shell');
    expect(readFileSync(jsPath, 'utf8')).toContain("from './state.js'");

    const app = await buildApp({ config: testConfig() });
    apps.push(app);
    const cssResponse = await app.inject({ method: 'GET', url: '/_proxy/ui/admin.css' });
    const jsResponse = await app.inject({ method: 'GET', url: '/_proxy/ui/admin.js' });
    const faviconResponse = await app.inject({ method: 'GET', url: '/favicon.ico' });

    expect(cssResponse.statusCode).toBe(200);
    expect(cssResponse.headers['content-type']).toContain('text/css');
    expect(cssResponse.body).toContain('.console-shell');
    expect(jsResponse.statusCode).toBe(200);
    expect(jsResponse.headers['content-type']).toContain('application/javascript');
    expect(jsResponse.body).toContain('renderObservability');
    expect(faviconResponse.statusCode).toBe(204);
  });

  it('keeps admin route responsibilities split into focused backend modules', () => {
    const adminSource = readFileSync('src/admin.ts', 'utf8');
    const expectedModules = [
      'src/admin/auth.ts',
      'src/admin/static.ts',
      'src/admin/observability.ts',
      'src/admin/keyActions.ts',
      'src/admin/webhook.ts'
    ];

    for (const modulePath of expectedModules) expect(existsSync(modulePath)).toBe(true);
    expect(adminSource).toContain("from './admin/auth.js'");
    expect(adminSource).toContain("from './admin/static.js'");
    expect(adminSource).toContain("from './admin/observability.js'");
    expect(adminSource).toContain("from './admin/keyActions.js'");
    expect(adminSource).toContain("from './admin/webhook.js'");
    expect(adminSource).not.toContain('function buildObservability');
    expect(adminSource).not.toContain('async function maybeDispatchAlertWebhook');
    expect(adminSource).not.toContain('async function testConfiguredKey');
    expect(adminSource).not.toContain('const adminUiPath');
  });

  it('serves the console with CSP headers and ES module assets', async () => {
    const uiSource = readFileSync('src/admin-ui/index.html', 'utf8');
    const expectedModules = [
      'src/admin-ui/api.js',
      'src/admin-ui/state.js',
      'src/admin-ui/renderKeys.js',
      'src/admin-ui/renderLogs.js',
      'src/admin-ui/renderObservability.js'
    ];

    for (const modulePath of expectedModules) expect(existsSync(modulePath)).toBe(true);
    expect(uiSource).toContain('<script type="module" src="/_proxy/ui/admin.js"></script>');

    const app = await buildApp({ config: testConfig() });
    apps.push(app);

    const root = await app.inject({ method: 'GET', url: '/' });
    const compat = await app.inject({ method: 'GET', url: '/_proxy/ui' });
    const moduleResponse = await app.inject({ method: 'GET', url: '/_proxy/ui/api.js' });

    for (const response of [root, compat]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['content-security-policy']).toContain("script-src 'self'");
      expect(response.headers['content-security-policy']).toContain("style-src 'self'");
      expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
      expect(response.headers['content-security-policy']).not.toContain("'unsafe-inline'");
    }
    expect(moduleResponse.statusCode).toBe(200);
    expect(moduleResponse.headers['content-type']).toContain('application/javascript');
  });

  it('serves versioned admin assets with cache headers and a manifest', async () => {
    const app = await buildApp({ config: testConfig() });
    apps.push(app);

    const root = await app.inject({ method: 'GET', url: '/' });
    const manifest = await app.inject({ method: 'GET', url: '/_proxy/ui/asset-manifest.json' });
    const manifestJson = manifest.json();
    const cssHash = manifestJson.assets['admin.css'].hash.slice(0, 12);
    const css = await app.inject({ method: 'GET', url: `/_proxy/ui/admin.css?v=${cssHash}` });
    const moduleResponse = await app.inject({ method: 'GET', url: '/_proxy/ui/admin.js?v=' + manifestJson.assets['admin.js'].hash.slice(0, 12) });

    expect(root.statusCode).toBe(200);
    expect(root.headers['cache-control']).toContain('no-store');
    expect(root.body).toContain('/_proxy/ui/admin.css?v=' + cssHash);
    expect(root.body).toContain('/_proxy/ui/admin.js?v=' + manifestJson.assets['admin.js'].hash.slice(0, 12));
    expect(root.body).toContain('id="assetVersion"');
    expect(manifest.statusCode).toBe(200);
    expect(manifestJson).toMatchObject({ version: expect.any(String), assets: { 'admin.css': { sha256: expect.any(String), hash: expect.any(String) } } });
    expect(css.headers['cache-control']).toContain('max-age=31536000');
    expect(css.headers['cache-control']).toContain('immutable');
    expect(css.headers['x-asset-sha256']).toBe(manifestJson.assets['admin.css'].sha256);
    expect(moduleResponse.body).toContain("./state.js?v=");
  });

  it('reports static asset integrity for the bytes actually served', async () => {
    const app = await buildApp({ config: testConfig() });
    apps.push(app);

    const manifest = await app.inject({ method: 'GET', url: '/_proxy/ui/asset-manifest.json' });
    const adminJsHash = manifest.json().assets['admin.js'].hash;
    const response = await app.inject({ method: 'GET', url: `/_proxy/ui/admin.js?v=${adminJsHash}` });
    const servedSha256 = createHash('sha256').update(response.body).digest('hex');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("./state.js?v=");
    expect(response.headers['x-asset-sha256']).toBe(servedSha256);
  });

  it('reloads admin assets between requests outside production for UI development', async () => {
    const cssPath = 'src/admin-ui/admin.css';
    const original = readFileSync(cssPath, 'utf8');
    const marker = `/* dev-reload-${Date.now()} */`;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      const app = await buildApp({ config: testConfig() });
      apps.push(app);
      const before = await app.inject({ method: 'GET', url: '/_proxy/ui/admin.css' });
      writeFileSync(cssPath, `${original}\n${marker}\n`);
      const after = await app.inject({ method: 'GET', url: '/_proxy/ui/admin.css' });

      expect(before.body).not.toContain(marker);
      expect(after.body).toContain(marker);
    } finally {
      writeFileSync(cssPath, original);
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it('uses a denser operations console layout', () => {
    const uiSource = `${readFileSync('src/admin-ui/index.html', 'utf8')}\n${readFileSync('src/admin-ui/admin.css', 'utf8')}`;

    expect(uiSource).toContain('console-density-pro');
    expect(uiSource).toContain('table-scroll key-table-scroll');
    expect(uiSource).toContain('table-scroll log-table-scroll');
    expect(uiSource).toContain('management-grid');
    expect(uiSource).toContain('grid-template-columns: minmax(700px, 1fr) 380px');
    expect(uiSource).toContain('height: 100vh; min-width: 1280px');
    expect(uiSource).toContain('grid-template-rows: 52px 40px minmax(0, 1fr)');
    expect(uiSource).toContain('grid-template-columns: 210px minmax(0, 1fr) auto');
    expect(uiSource).toContain('min-height: 0;');
    expect(uiSource).toContain('.keys-panel { min-height: 342px; }');
  });
  it('requires admin auth and keeps raw key display ids disabled by default', async () => {
    const app = await buildApp({ config: testConfig({ keys: [{ id: 'a', value: 'secret-key-a', weight: 1, enabled: true }] }) });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/_proxy/keys' })).statusCode).toBe(401);
    const response = await app.inject({ method: 'GET', url: '/_proxy/keys', headers: { authorization: 'Bearer admin_token' } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"id":"a"');
    expect(response.body).toContain('"displayId":"a"');
    expect(response.body).not.toContain('secret-key-a');
    expect(response.body).not.toContain('"value"');
  });

  it('can explicitly allow raw display ids for local-only deployments', async () => {
    const app = await buildApp({ config: testConfig({ allowRawKeyDisplay: true, keys: [{ id: 'a', value: 'secret-key-a', weight: 1, enabled: true }] }) });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/_proxy/keys', headers: { authorization: 'Bearer admin_token' } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"displayId":"secret-key-a"');
    expect(response.body).not.toContain('"value"');
  });

  it('requires explicit raw-key permission and audits raw key reveal requests', async () => {
    const deniedApp = await buildApp({ config: testConfig({ keys: [{ id: 'a', value: 'secret-key-a', weight: 1, enabled: true }] }) });
    apps.push(deniedApp);

    const denied = await deniedApp.inject({ method: 'POST', url: '/_proxy/keys/a/secret', headers: { authorization: 'Bearer admin_token' } });
    expect(denied.statusCode).toBe(403);

    const app = await buildApp({ config: testConfig({ allowRawKeyDisplay: true, keys: [{ id: 'a', value: 'secret-key-a', weight: 1, enabled: true }] }) });
    apps.push(app);
    const revealed = await app.inject({ method: 'POST', url: '/_proxy/keys/a/secret', headers: { authorization: 'Bearer admin_token' } });
    const audit = await app.inject({ method: 'GET', url: '/_proxy/audit', headers: { authorization: 'Bearer admin_token' } });

    expect(revealed.statusCode).toBe(200);
    expect(revealed.json()).toMatchObject({ ok: true, id: 'a', secret: 'secret-key-a' });
    expect(revealed.body).not.toContain('"value"');
    expect(audit.json().audit.some((item: any) => item.action === 'reveal_key_secret' && item.targetId === 'a')).toBe(true);
  });

  it('disables and enables keys', async () => {
    const app = await buildApp({ config: testConfig() });
    apps.push(app);
    const headers = { authorization: 'Bearer admin_token' };

    expect((await app.inject({ method: 'POST', url: '/_proxy/keys/a/disable', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/_proxy/keys/a/enable', headers })).statusCode).toBe(200);
  });

  it('tests a selected upstream key without leaking the raw key', async () => {
    let upstreamKey = '';
    const fake = await createFakeExa((request) => {
      upstreamKey = request.headers['x-api-key'] ?? '';
      return { status: 200, body: { results: [{ id: 'ok' }] } };
    });
    apps.push(fake.app);
    const app = await buildApp({
      config: testConfig({
        upstreamUrl: fake.url,
        keys: [{ id: 'a', value: 'secret-key-a', weight: 1, enabled: true }]
      })
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/_proxy/keys/a/test',
      headers: { authorization: 'Bearer admin_token' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, id: 'a', status: 200 });
    expect(upstreamKey).toBe('secret-key-a');
    expect(response.body).not.toContain('secret-key-a');
  });


  it('creates expiring admin sessions, rate-limits failed logins, and records audit entries', async () => {
    const app = await buildApp({ config: testConfig({ adminLockoutMaxFailures: 2, adminLockoutWindowSeconds: 60, adminLockoutSeconds: 60 }) });
    apps.push(app);

    expect((await app.inject({ method: 'POST', url: '/_proxy/session', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/_proxy/session', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/_proxy/session', headers: { authorization: 'Bearer admin_token' } })).statusCode).toBe(423);

    const cleanApp = await buildApp({ config: testConfig() });
    apps.push(cleanApp);
    const login = await cleanApp.inject({ method: 'POST', url: '/_proxy/session', headers: { authorization: 'Bearer admin_token' } });
    const session = login.json();
    const health = await cleanApp.inject({ method: 'GET', url: '/_proxy/health', headers: { 'x-admin-session-id': session.sessionId } });
    const audit = await cleanApp.inject({ method: 'GET', url: '/_proxy/audit', headers: { 'x-admin-session-id': session.sessionId } });

    expect(login.statusCode).toBe(200);
    expect(session.sessionId).toBeTruthy();
    expect(session.tokenId).toMatch(/^tok_/);
    expect(health.statusCode).toBe(200);
    expect(audit.json().audit.some((item: any) => item.action === 'login' && item.success === true)).toBe(true);
  });

  it('persists admin sessions across app restarts and revokes them on logout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exa-admin-session-'));
    const dbPath = join(dir, 'state.sqlite');
    const localApps: Array<{ close(): Promise<void> }> = [];

    try {
      const firstApp = await buildApp({ config: testConfig({ statePath: dbPath }) });
      localApps.push(firstApp);
      const login = await firstApp.inject({ method: 'POST', url: '/_proxy/session', headers: { authorization: 'Bearer admin_token' } });
      const sessionId = login.json().sessionId;
      await localApps.pop()!.close();

      const restartedApp = await buildApp({ config: testConfig({ statePath: dbPath }) });
      localApps.push(restartedApp);
      const persisted = await restartedApp.inject({ method: 'GET', url: '/_proxy/health', headers: { 'x-admin-session-id': sessionId } });
      const logout = await restartedApp.inject({ method: 'DELETE', url: '/_proxy/session', headers: { 'x-admin-session-id': sessionId } });
      await localApps.pop()!.close();

      const revokedApp = await buildApp({ config: testConfig({ statePath: dbPath }) });
      localApps.push(revokedApp);
      const revoked = await revokedApp.inject({ method: 'GET', url: '/_proxy/health', headers: { 'x-admin-session-id': sessionId } });

      expect(login.statusCode).toBe(200);
      expect(sessionId).toEqual(expect.any(String));
      expect(persisted.statusCode).toBe(200);
      expect(logout.statusCode).toBe(200);
      expect(revoked.statusCode).toBe(401);
    } finally {
      while (localApps.length > 0) await localApps.pop()!.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects expired admin sessions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T00:00:00Z'));
    const app = await buildApp({ config: testConfig({ adminSessionTtlSeconds: 1 }) });
    apps.push(app);

    const login = await app.inject({ method: 'POST', url: '/_proxy/session', headers: { authorization: 'Bearer admin_token' } });
    const session = login.json();
    const during = await app.inject({ method: 'GET', url: '/_proxy/health', headers: { 'x-admin-session-id': session.sessionId } });

    await vi.advanceTimersByTimeAsync(1500);
    const expired = await app.inject({ method: 'GET', url: '/_proxy/health', headers: { 'x-admin-session-id': session.sessionId } });

    expect(login.statusCode).toBe(200);
    expect(during.statusCode).toBe(200);
    expect(expired.statusCode).toBe(401);
  });

  it('enforces HTTPS for admin APIs when configured', async () => {
    const app = await buildApp({ config: testConfig({ adminRequireHttps: true }) });
    apps.push(app);

    const plainLogin = await app.inject({ method: 'POST', url: '/_proxy/session', headers: { authorization: 'Bearer admin_token' } });
    const httpsLogin = await app.inject({ method: 'POST', url: '/_proxy/session', headers: { authorization: 'Bearer admin_token', 'x-forwarded-proto': 'https' } });
    const session = httpsLogin.json();
    const plainHealth = await app.inject({ method: 'GET', url: '/_proxy/health', headers: { 'x-admin-session-id': session.sessionId } });
    const httpsHealth = await app.inject({ method: 'GET', url: '/_proxy/health', headers: { 'x-admin-session-id': session.sessionId, 'x-forwarded-proto': 'https' } });

    expect(plainLogin.statusCode).toBe(426);
    expect(httpsLogin.statusCode).toBe(200);
    expect(plainHealth.statusCode).toBe(426);
    expect(httpsHealth.statusCode).toBe(200);
  });

  it('reports observability alerts and supports filtered CSV log export', async () => {
    const app = await buildApp({ config: testConfig({ alertAvailableKeyMin: 3, alertFailureRatePercent: 1, alertRateLimitRatePercent: 1 }) });
    apps.push(app);
    const proxyHeaders = { authorization: 'Bearer client_token', 'content-type': 'application/json' };
    const adminHeaders = { authorization: 'Bearer admin_token' };

    await app.inject({ method: 'GET', url: '/blocked', headers: proxyHeaders });
    await app.inject({ method: 'GET', url: '/search', headers: { authorization: 'Bearer bad' } });
    const logs = await app.inject({ method: 'GET', url: '/_proxy/logs?status=4xx&path=blocked', headers: adminHeaders });
    const exportResponse = await app.inject({ method: 'GET', url: '/_proxy/logs/export?status=4xx', headers: adminHeaders });
    const observability = await app.inject({ method: 'GET', url: '/_proxy/observability', headers: adminHeaders });

    expect(logs.statusCode).toBe(200);
    expect(logs.json().logs.every((log: any) => log.status >= 400 && log.status < 500 && log.path.includes('blocked'))).toBe(true);
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers['content-type']).toContain('text/csv');
    expect(exportResponse.body).toContain('createdAt,requestId,method,path,query,status');
    expect(observability.statusCode).toBe(200);
    expect(observability.json().trends.length).toBeGreaterThan(0);
    expect(observability.json().alerts.some((alert: any) => alert.id === 'available_keys_low')).toBe(true);
    expect(observability.json().retention).toMatchObject({
      days: 14,
      totalLogs: expect.any(Number),
      retainedLogs: expect.any(Number),
      expiredLogs: expect.any(Number),
      cutoffMs: expect.any(Number)
    });
    expect(observability.json().webhook).toMatchObject({ enabled: false });
  });

  it('exposes request traces, per-key failure summaries, and audit export', async () => {
    const fake = await createFakeExa((request) => {
      if (request.headers['x-api-key'] === 'key-a') return { status: 503, body: { error: 'temporary failure' } };
      return { status: 200, body: { results: [{ id: 'ok' }] } };
    });
    apps.push(fake.app);
    const app = await buildApp({
      config: testConfig({
        upstreamUrl: fake.url,
        keys: [
          { id: 'a', value: 'key-a', weight: 1, enabled: true },
          { id: 'b', value: 'key-b', weight: 1, enabled: true }
        ]
      })
    });
    apps.push(app);
    const headers = { authorization: 'Bearer admin_token', 'x-request-id': 'req_trace_admin' };

    await app.inject({ method: 'POST', url: '/_proxy/keys/a/test', headers });
    await app.inject({ method: 'POST', url: '/_proxy/keys/b/test', headers });
    const trace = await app.inject({ method: 'GET', url: '/_proxy/logs/trace/req_trace_admin', headers });
    const failures = await app.inject({ method: 'GET', url: '/_proxy/keys/a/failures', headers });
    const auditExport = await app.inject({ method: 'GET', url: '/_proxy/audit/export?action=test_key&success=false', headers });

    expect(trace.statusCode).toBe(200);
    expect(trace.json()).toMatchObject({ requestId: 'req_trace_admin', trace: expect.any(Array) });
    expect(trace.json().trace.map((log: any) => log.status)).toEqual([503, 200]);
    expect(failures.statusCode).toBe(200);
    expect(failures.json().summary).toMatchObject({ keyId: 'a', totalFailures: 1, reasons: { transient_status: 1 } });
    expect(auditExport.statusCode).toBe(200);
    expect(auditExport.headers['content-type']).toContain('text/csv');
    expect(auditExport.body).toContain('createdAt,actorTokenId,action,targetId,success,detail,ip,userAgent');
    expect(auditExport.body).toContain('test_key');
    expect(auditExport.body).not.toContain('key-a');
  });

  it('returns a sanitized runtime config summary for the console', async () => {
    const app = await buildApp({
      config: testConfig({
        host: '127.0.0.1',
        port: 8787,
        upstreamUrl: 'https://api.exa.ai',
        selectionStrategy: 'least_recently_used',
        allowedPaths: ['/search', '/contents'],
        adminRequireHttps: true,
        allowRawKeyDisplay: true,
        alertWebhookUrl: 'https://ops.example.test/hook?token=secret',
        alertWebhookBearerToken: 'webhook-token',
        keys: [{ id: 'a', value: 'secret-key-a', weight: 1, enabled: true }]
      } as any)
    });
    apps.push(app);

    const denied = await app.inject({ method: 'GET', url: '/_proxy/config-summary' });
    const response = await app.inject({
      method: 'GET',
      url: '/_proxy/config-summary',
      headers: { authorization: 'Bearer admin_token', 'x-forwarded-proto': 'https' }
    });

    expect(denied.statusCode).toBe(426);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      listen: '127.0.0.1:8787',
      upstream: 'https://api.exa.ai',
      selectionStrategy: 'least_recently_used',
      allowedPaths: { count: 2, preview: ['/search', '/contents'] },
      resourceAffinity: true,
      logRetentionDays: 14,
      adminRequireHttps: true,
      rawKeyDisplayAllowed: true,
      webhook: { enabled: true, target: 'https://ops.example.test/hook' }
    });
    expect(response.body).not.toContain('secret-key-a');
    expect(response.body).not.toContain('admin_token');
    expect(response.body).not.toContain('webhook-token');
    expect(response.body).not.toContain('token=secret');
  });

  it('renders broader Prometheus metrics without leaking raw keys', async () => {
    const app = await buildApp({
      config: testConfig({
        alertAvailableKeyMin: 3,
        keys: [{ id: 'a', value: 'secret-key-a', weight: 1, enabled: true }]
      })
    });
    apps.push(app);

    await app.inject({ method: 'GET', url: '/search', headers: { authorization: 'Bearer bad' } });
    const response = await app.inject({ method: 'GET', url: '/_proxy/metrics', headers: { authorization: 'Bearer admin_token' } });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# HELP exa_proxy_requests_total');
    expect(response.body).toContain('exa_proxy_key_success_total{key_id="a"}');
    expect(response.body).toContain('exa_proxy_keys_healthy ');
    expect(response.body).toContain('exa_proxy_alerts_active ');
    expect(response.body).toContain('exa_proxy_log_retention_days 14');
    expect(response.body).toContain('exa_proxy_request_logs_total ');
    expect(response.body).toContain('exa_proxy_request_status_group_total{status_group="4xx"}');
    expect(response.body).toContain('exa_proxy_request_latency_p95_ms ');
    expect(response.body).toContain('exa_proxy_retries_total ');
    expect(response.body).toContain('exa_proxy_upstream_error_total{reason="unauthorized"}');
    expect(response.body).not.toContain('secret-key-a');
  });

  it('exports retry, upstream-error, and cooldown-reason metrics with low-cardinality labels', async () => {
    const app = await buildApp({
      config: testConfig({
        failureThreshold: 1,
        keys: [{ id: 'a', value: 'secret-key-a', weight: 1, enabled: true }]
      })
    });
    apps.push(app);

    await app.inject({
      method: 'POST',
      url: '/search',
      headers: { authorization: 'Bearer client_token', 'content-type': 'application/json' },
      payload: { query: 'metrics failure path', numResults: 1 }
    });
    const response = await app.inject({ method: 'GET', url: '/_proxy/metrics', headers: { authorization: 'Bearer admin_token' } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('exa_proxy_request_status_group_total{status_group="5xx"}');
    expect(response.body).toContain('exa_proxy_upstream_error_total{reason="connection_error"}');
    expect(response.body).toContain('exa_proxy_cooldown_reason_total{reason="connection_error"}');
    expect(response.body).not.toContain('/search');
    expect(response.body).not.toContain('secret-key-a');
  });

  it('dispatches configured alert webhooks with sanitized alert payloads, retry metadata, and signatures', async () => {
    const deliveries: any[] = [];
    const receiver = await createFakeExa((request) => {
      deliveries.push(request);
      return { status: deliveries.length === 1 ? 500 : 204, body: '' };
    });
    apps.push(receiver.app);
    const app = await buildApp({
      config: testConfig({
        alertAvailableKeyMin: 3,
        alertWebhookUrl: receiver.url,
        alertWebhookBearerToken: 'webhook-token',
        alertWebhookHmacSecret: 'signing-secret',
        alertWebhookCooldownSeconds: 60,
        alertWebhookMaxAttempts: 2,
        alertWebhookRetryBackoffMs: 1,
        keys: [{ id: 'a', value: 'secret-key-a', weight: 1, enabled: true }]
      } as any)
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/_proxy/observability', headers: { authorization: 'Bearer admin_token' } });
    const observability = response.json();

    expect(response.statusCode).toBe(200);
    expect(observability.webhook).toMatchObject({ enabled: true, lastStatus: 'sent', lastStatusCode: 204, lastAttempts: 2, signed: true });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].headers.authorization).toBe('Bearer webhook-token');
    expect(deliveries[1].headers['x-exa-alert-signature']).toMatch(/^sha256=/);
    expect(deliveries[1].body.alerts.some((alert: any) => alert.id === 'available_keys_low')).toBe(true);
    expect(JSON.stringify(deliveries[1].body)).not.toContain('secret-key-a');
  });

  it('can send an explicit test alert webhook from the admin console', async () => {
    const deliveries: any[] = [];
    const receiver = await createFakeExa((request) => {
      deliveries.push(request);
      return { status: 204, body: '' };
    });
    apps.push(receiver.app);
    const app = await buildApp({
      config: testConfig({
        alertWebhookUrl: receiver.url,
        alertWebhookHmacSecret: 'signing-secret'
      } as any)
    });
    apps.push(app);

    const response = await app.inject({ method: 'POST', url: '/_proxy/alerts/webhook/test', headers: { authorization: 'Bearer admin_token' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, statusCode: 204, attempts: 1 });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].headers['x-exa-alert-signature']).toMatch(/^sha256=/);
    expect(deliveries[0].body.alerts[0]).toMatchObject({ id: 'webhook_test', severity: 'info' });
  });


  it('filters logs by key id, honors trend windows, and audits retention pruning', async () => {
    const app = await buildApp({ config: testConfig({ alertAvailableKeyMin: 0 }) });
    apps.push(app);
    const proxyHeaders = { authorization: 'Bearer client_token', 'content-type': 'application/json' };
    const adminHeaders = { authorization: 'Bearer admin_token', 'content-type': 'application/json' };

    await app.inject({ method: 'GET', url: '/search?first=1', headers: proxyHeaders });
    await app.inject({ method: 'GET', url: '/search?second=1', headers: proxyHeaders });

    const byKey = await app.inject({ method: 'GET', url: '/_proxy/logs?keyId=a&limit=20', headers: adminHeaders });
    const oneHour = await app.inject({ method: 'GET', url: '/_proxy/observability?hours=1', headers: adminHeaders });
    const sevenDays = await app.inject({ method: 'GET', url: '/_proxy/observability?hours=168', headers: adminHeaders });
    const pruned = await app.inject({ method: 'POST', url: '/_proxy/logs/prune', headers: adminHeaders, payload: { olderThanMs: Date.now() + 1000 } });
    const audit = await app.inject({ method: 'GET', url: '/_proxy/audit', headers: adminHeaders });

    expect(byKey.statusCode).toBe(200);
    expect(byKey.json().logs.length).toBeGreaterThan(0);
    expect(byKey.json().logs.every((log: any) => log.keyIds.includes('a'))).toBe(true);
    expect(oneHour.json().window.hours).toBe(1);
    expect(sevenDays.json().window.hours).toBe(168);
    expect(sevenDays.json().trends.length).toBeGreaterThan(oneHour.json().trends.length);
    expect(pruned.statusCode).toBe(200);
    expect(pruned.json().deleted).toBeGreaterThan(0);
    expect(audit.json().audit.some((item: any) => item.action === 'prune_logs')).toBe(true);
  });

  it('supports batch key operations and keeps audit records', async () => {
    const app = await buildApp({ config: testConfig() });
    apps.push(app);
    const headers = { authorization: 'Bearer admin_token', 'content-type': 'application/json' };

    const batch = await app.inject({ method: 'POST', url: '/_proxy/keys/batch', headers, payload: { ids: ['a', 'b'], action: 'disable' } });
    const keys = await app.inject({ method: 'GET', url: '/_proxy/keys', headers });
    const audit = await app.inject({ method: 'GET', url: '/_proxy/audit', headers });

    expect(batch.statusCode).toBe(200);
    expect(batch.json().results).toHaveLength(2);
    expect(keys.json().keys.every((key: any) => key.enabled === false)).toBe(true);
    expect(audit.json().audit.some((item: any) => item.action === 'batch_disable')).toBe(true);
  });

  it('keeps the admin event stream open for live console refresh', async () => {
    const app = await buildApp({ config: testConfig() });
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to listen');

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/_proxy/events`, {
      headers: { authorization: 'Bearer admin_token' },
      signal: controller.signal
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    const next = await Promise.race([
      reader.read().then((result) => result.done ? 'closed' : 'chunk'),
      new Promise((resolve) => setTimeout(() => resolve('open'), 80))
    ]);

    controller.abort();
    await reader.cancel().catch(() => {});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(first.done).toBe(false);
    expect(firstText).toContain('event: snapshot');
    expect(next).toBe('open');
  });

  it('streams admin console update events with admin authentication', async () => {
    const app = await buildApp({ config: testConfig() });
    apps.push(app);

    const denied = await app.inject({ method: 'GET', url: '/_proxy/events' });
    const allowed = await app.inject({ method: 'GET', url: '/_proxy/events?once=true', headers: { authorization: 'Bearer admin_token' } });

    expect(denied.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toContain('text/event-stream');
    expect(allowed.body).toContain('event: snapshot');
    expect(allowed.body).toContain('"keyCount"');
    expect(allowed.body).toContain('"logCount"');
  });

  it('serves a built-in admin web UI', async () => {
    const app = await buildApp({ config: testConfig() });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/_proxy/ui' });
    const rootResponse = await app.inject({ method: 'GET', url: '/' });
    const cssSource = readFileSync('src/admin-ui/admin.css', 'utf8');
    const jsSource = [
      'src/admin-ui/admin.js',
      'src/admin-ui/api.js',
      'src/admin-ui/state.js',
      'src/admin-ui/renderKeys.js',
      'src/admin-ui/renderLogs.js',
      'src/admin-ui/renderObservability.js'
    ].filter(existsSync).map((path) => readFileSync(path, 'utf8')).join('\n');
    const uiBundle = `${response.body}\n${cssSource}\n${jsSource}`;

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(rootResponse.statusCode).toBe(200);
    expect(rootResponse.headers['content-type']).toContain('text/html');
    expect(rootResponse.body).toContain('Exa 代理控制台');
    expect(uiBundle).toContain('Exa 代理控制台');
    expect(uiBundle).toContain('data-login-screen');
    expect(uiBundle).toContain('管理员令牌');
    expect(uiBundle).toContain('EXA_ADMIN_TOKENS');
    expect(uiBundle).toContain('不是 Exa API Key');
    expect(uiBundle).toContain('管理员登录');
    expect(uiBundle).toContain('运维访问');
    expect(uiBundle).toContain('运维访问令牌');
    expect(uiBundle).toContain('auth-card-brand');
    expect(uiBundle).toContain('auth-access-note');
    expect(uiBundle).toContain('.auth-screen { min-height: 100vh; display: grid; place-items: center;');
    expect(uiBundle).not.toContain('place-items: center end');
    expect(uiBundle).toContain('.login-head h1 { margin: 0; font-size: 24px; line-height: 1.18; color: #f8fafc; font-weight: 650; }');
    expect(uiBundle).not.toContain('已加密');
    expect(uiBundle).not.toContain('登录前仪表盘');
    expect(uiBundle).not.toContain('auth-dashboard');
    expect(uiBundle).not.toContain('auth-log-table');
    expect(uiBundle).not.toContain('auth-brand');
    expect(uiBundle).not.toContain('Exa API 反向代理</h1>');
    expect(uiBundle).not.toContain('欢迎回来');
    expect(uiBundle).toContain('id="loginToken"');
    expect(uiBundle).toContain('id="loginButton"');
    expect(uiBundle).toContain('showLogin');
    expect(uiBundle).toContain('showConsole');
    expect(uiBundle).toContain('/_proxy/health');
    expect(uiBundle).toContain('/_proxy/events');
    expect(uiBundle).not.toContain('once=true');
    expect(uiBundle).toContain('EventSource');
    expect(uiBundle).not.toContain('请输入管理员密钥');
    expect(uiBundle).not.toContain('请输入邮箱');
    expect(uiBundle).not.toContain('邮箱');
    expect(uiBundle).toContain('服务状态');
    expect(uiBundle).toContain('概览');
    expect(uiBundle).toContain('审计与配置');
    expect(uiBundle).toContain('自动刷新');
    expect(uiBundle).toContain('近 24 小时');
    expect(uiBundle).toContain('全部');
    expect(uiBundle).toContain('密钥详情');
    expect(uiBundle).toContain('密钥池');
    expect(uiBundle).toContain('请求日志');
    expect(uiBundle).toContain('displayLabel');
    expect(uiBundle).toContain('测试密钥');
    expect(uiBundle).toContain('操作反馈');
    expect(uiBundle).toContain('重置熔断');
    expect(uiBundle).toContain('禁用密钥');
    expect(uiBundle).toContain('上游超时');
    expect(uiBundle).toContain('连接异常');
    expect(uiBundle).toContain('临时错误');
    expect(uiBundle).not.toContain('添加密钥');
    expect(uiBundle).toContain('筛选</button>');
    expect(uiBundle).toContain('趋势视图');
    expect(uiBundle).toContain('告警中心');
    expect(uiBundle).toContain('管理员审计');
    expect(uiBundle).toContain('导出</button>');
    expect(uiBundle).toContain('脱敏显示');
    expect(uiBundle).toContain('data-console-shell');
    expect(uiBundle).toContain('details-sticky');
    expect(uiBundle).toContain('/_proxy/keys');
    expect(uiBundle).toContain('/_proxy/logs');
    expect(uiBundle).toContain("localStorage.getItem('exaProxyAdminToken')");
    expect(uiBundle).toContain('Microsoft YaHei UI');
    expect(uiBundle).toContain('brand-title');
    expect(uiBundle).toContain('log-path');
    expect(uiBundle).toContain('log-chain');
    expect(uiBundle).not.toContain('data-nav-target=');
    expect(uiBundle).not.toContain('aria-label="主导航"');
    expect(uiBundle).toContain('data-tab-panel="keys"');
    expect(uiBundle).not.toContain('switchView');
    expect(uiBundle).toContain('运行配置');
    expect(uiBundle).toContain('metric-head');
    expect(uiBundle).toContain('metric-chip');
    expect(uiBundle).toContain('metric-meter');
    expect(uiBundle).toContain('metric-meter-fill');
    expect(uiBundle).toContain('id="usageMeter"');
    expect(uiBundle).toContain('id="successMeter"');
    expect(uiBundle).toContain('id="rateLimitMeter"');
    expect(uiBundle).toContain('id="latencyMeter"');
    expect(uiBundle).toContain('id="failureMeter"');
    expect(uiBundle).toContain('updateMetricMeters');
    expect(uiBundle).toContain('keyPageSize: 50');
    expect(uiBundle).toContain('id="prevKeyPage"');
    expect(uiBundle).toContain('id="nextKeyPage"');
    expect(uiBundle).toContain("data-action=\"test\"");
    expect(uiBundle).toContain("'/test'");
    expect(uiBundle).not.toContain('.metric-meter-fill.green { width:');
    expect(uiBundle).not.toContain('.metric-meter-fill.amber { width:');
    expect(uiBundle).not.toContain('.metric-meter-fill.red { width:');
    expect(uiBundle).toContain('运行态势');
    expect(uiBundle).toContain('状态分布');
    expect(uiBundle).toContain('链路诊断');
    expect(uiBundle).toContain('告警摘要');
    expect(uiBundle).toContain('冷却处理');
    expect(uiBundle).toContain('ops-strip');
    expect(uiBundle).toContain('workbench-shell');
    expect(uiBundle).toContain('primary-workspace');
    expect(uiBundle).toContain('metrics-compact');
    expect(uiBundle).toContain('keys-panel primary-panel');
    expect(uiBundle).toContain('details-sticky');
    expect(uiBundle).toContain('控制台总览');
    expect(uiBundle).toContain('detail-kpis');
    expect(uiBundle).toContain('cooldown-card');
    expect(uiBundle).toContain('incident-timeline');
    expect(uiBundle).toContain('updateOpsStrip');
    expect(uiBundle).toContain('isOperationalLog');
    expect(uiBundle).not.toContain('class="spark');
    expect(uiBundle).not.toContain('.spark {');
  });
});
