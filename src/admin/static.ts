import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const ADMIN_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'"
].join('; ');

const assetPaths = new Map<string, { path: URL; type: string }>([
  ['admin.css', { path: new URL('../admin-ui/admin.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['admin.js', { path: new URL('../admin-ui/admin.js', import.meta.url), type: 'application/javascript; charset=utf-8' }],
  ['api.js', { path: new URL('../admin-ui/api.js', import.meta.url), type: 'application/javascript; charset=utf-8' }],
  ['state.js', { path: new URL('../admin-ui/state.js', import.meta.url), type: 'application/javascript; charset=utf-8' }],
  ['renderKeys.js', { path: new URL('../admin-ui/renderKeys.js', import.meta.url), type: 'application/javascript; charset=utf-8' }],
  ['renderLogs.js', { path: new URL('../admin-ui/renderLogs.js', import.meta.url), type: 'application/javascript; charset=utf-8' }],
  ['renderObservability.js', { path: new URL('../admin-ui/renderObservability.js', import.meta.url), type: 'application/javascript; charset=utf-8' }]
]);

const adminUiPath = new URL('../admin-ui/index.html', import.meta.url);

type AssetManifest = {
  version: string;
  generatedAt: string;
  assets: Record<string, { hash: string; sha256: string; path: string }>;
};

type AssetBundle = {
  manifest: AssetManifest;
  bodies: Record<string, string>;
};

let assetBundlePromise: Promise<AssetBundle> | null = null;

function shouldCacheAssets(): boolean {
  return process.env.NODE_ENV === 'production';
}

function withAdminSecurityHeaders(reply: any): any {
  return reply
    .header('content-security-policy', ADMIN_CSP)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}

async function readAdminUi(): Promise<string> {
  const [html, bundle] = await Promise.all([readFile(adminUiPath, 'utf8'), buildAssetBundle()]);
  const manifest = bundle.manifest;
  return html
    .replace('/_proxy/ui/admin.css"', `/_proxy/ui/admin.css?v=${manifest.assets['admin.css'].hash}"`)
    .replace('/_proxy/ui/admin.js"', `/_proxy/ui/admin.js?v=${manifest.assets['admin.js'].hash}"`)
    .replace('id="assetVersion" class="brand-version">版本 -', `id="assetVersion" class="brand-version">版本 ${manifest.version}`);
}

async function readAsset(name: string): Promise<{ body: string; type: string } | null> {
  const asset = assetPaths.get(name);
  if (!asset) return null;
  const bundle = await buildAssetBundle();
  return { body: bundle.bodies[name], type: asset.type };
}

function sha256Hex(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

async function buildAssetBundle(): Promise<AssetBundle> {
  if (shouldCacheAssets() && assetBundlePromise) return assetBundlePromise;
  const bundlePromise = (async () => {
    const sourceBodies: Record<string, string> = {};
    let hashes: Record<string, string> = {};
    for (const [name, asset] of assetPaths.entries()) {
      sourceBodies[name] = await readFile(asset.path, 'utf8');
      hashes[name] = sha256Hex(sourceBodies[name]).slice(0, 12);
    }

    let bodies: Record<string, string> = {};
    for (let pass = 0; pass < 8; pass += 1) {
      const nextHashes: Record<string, string> = {};
      const nextBodies: Record<string, string> = {};
      for (const name of assetPaths.keys()) {
        const body = transformAssetBody(name, sourceBodies[name], hashes);
        const sha256 = sha256Hex(body);
        nextBodies[name] = body;
        nextHashes[name] = sha256.slice(0, 12);
      }
      bodies = nextBodies;
      const changed = Object.keys(nextHashes).some((name) => nextHashes[name] !== hashes[name]);
      hashes = nextHashes;
      if (!changed) break;
    }

    const assets: AssetManifest['assets'] = {};
    for (const name of assetPaths.keys()) {
      const sha256 = sha256Hex(bodies[name]);
      assets[name] = { hash: sha256.slice(0, 12), sha256, path: `/_proxy/ui/${name}` };
    }
    const version = sha256Hex(
      Object.entries(assets).map(([name, meta]) => `${name}:${meta.sha256}`).sort().join('|')
    ).slice(0, 12);
    return {
      manifest: { version, generatedAt: new Date(0).toISOString(), assets },
      bodies
    };
  })();
  if (shouldCacheAssets()) assetBundlePromise = bundlePromise;
  return bundlePromise;
}

async function buildAssetManifest(): Promise<AssetManifest> {
  return (await buildAssetBundle()).manifest;
}

function transformAssetBody(name: string, body: string, hashes: Record<string, string>): string {
  if (!name.endsWith('.js')) return body;
  return body.replace(/from '(\.\/([^']+\.js))'/g, (match, specifier: string, fileName: string) => {
    const hash = hashes[fileName];
    return hash ? `from '${specifier}?v=${hash}'` : match;
  });
}

function cacheControlForAsset(assetName: string, version: string | undefined, manifest: AssetManifest): string {
  const expected = manifest.assets[assetName]?.hash;
  if (version && expected && expected === version) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

export async function registerAdminStaticRoutes(app: FastifyInstance): Promise<void> {
  const sendAdminUi = async (_request: unknown, reply: any) => withAdminSecurityHeaders(reply)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(await readAdminUi());

  app.get('/', sendAdminUi);
  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());
  app.get('/_proxy/ui', sendAdminUi);
  app.get('/_proxy/ui/asset-manifest.json', async (_request, reply) => withAdminSecurityHeaders(reply)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'no-cache')
    .send(await buildAssetManifest()));
  app.get('/_proxy/ui/:asset', async (request, reply) => {
    const assetName = (request.params as { asset: string }).asset;
    const query = request.query as { v?: string };
    const manifest = await buildAssetManifest();
    if (query.v && manifest.assets[assetName]?.hash !== query.v) return reply.code(412).send({ error: 'asset_version_mismatch' });
    const asset = await readAsset(assetName);
    if (!asset) return reply.code(404).send({ error: 'not_found' });
    const meta = manifest.assets[assetName];
    const response = withAdminSecurityHeaders(reply)
      .type(asset.type)
      .header('cache-control', cacheControlForAsset(assetName, query.v, manifest));
    if (meta) response.header('etag', `"${meta.hash}"`).header('x-asset-sha256', meta.sha256);
    return response.send(asset.body);
  });
}
