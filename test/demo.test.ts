import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('demo ui script', () => {
  it('exposes a reproducible Chinese admin UI demo entrypoint', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['demo:ui']).toBe('tsx scripts/demo-ui-server.ts');
    expect(existsSync('scripts/demo-ui-server.ts')).toBe(true);

    const script = readFileSync('scripts/demo-ui-server.ts', 'utf8');
    expect(script).toContain('admin_local_token');
    expect(script).toContain('client_local_token');
    expect(script).toContain("console.log('地址: http://127.0.0.1:8787');");
    expect(script).not.toContain('http://127.0.0.1:8787/_proxy/ui');
    expect(script).toContain('触发一把搜索密钥限流');
    expect(script).toContain('冷却');
  });

  it('documents the local demo console flow in Chinese', () => {
    const readme = readFileSync('README.md', 'utf8');
    const checklist = readFileSync('docs/DEPLOYMENT_CHECKLIST.md', 'utf8');
    const vitestConfig = readFileSync('vitest.config.ts', 'utf8');

    expect(readme).toContain('控制台预览');
    expect(readme).toContain('npm run demo:ui');
    expect(readme).toContain('http://127.0.0.1:8787');
    expect(readme).not.toContain('http://127.0.0.1:8787/_proxy/ui');
    expect(readme).toContain('管理员令牌');
    expect(readme).toContain('AES-256-GCM');
    expect(readme).toContain('npm run backup:docker');
    expect(readme).toContain('npm run restore:docker');
    expect(readme).toContain('POST /_proxy/keys');

    expect(checklist).toContain('EXA_KEYS_ENCRYPTION_SECRET');
    expect(checklist).not.toContain('http://127.0.0.1:8787/_proxy/ui');
    expect(checklist).toContain('EXA_PROXY_TOKENS');
    expect(checklist).toContain('/_proxy/keys');
    expect(checklist).toContain('管理员令牌');
    expect(vitestConfig).toContain("include: ['test/**/*.test.ts']");
  });
});
