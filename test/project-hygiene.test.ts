import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootBatScripts = [
  'scripts/prepare-deployment.bat',
  'scripts/fix-sqlite.bat',
  'scripts/check-docker.bat',
  'scripts/publish-docker-hub.bat'
];

describe('project hygiene', () => {
  it('runs project-level Windows scripts from the repository root', () => {
    for (const scriptPath of rootBatScripts) {
      const content = readFileSync(scriptPath, 'utf8');
      expect(content, scriptPath).toContain('cd /d "%~dp0.."');
    }
  });

  it('keeps Docker build lean by only copying build-essential files', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const dockerignore = readFileSync('.dockerignore', 'utf8');

    expect(dockerfile).toContain('COPY src ./src');
    expect(dockerfile).toContain('COPY scripts ./scripts');
    expect(dockerfile).not.toContain('COPY test');
    expect(dockerfile).not.toContain('COPY docs');
    expect(dockerfile).not.toContain('COPY .github');
    expect(dockerfile).toContain('/_proxy/live');
    expect(dockerignore).toContain('*.md');
    expect(dockerignore).toContain('!README.md');
    expect(dockerignore).toContain('docs/superpowers');
    expect(dockerignore).toContain('docs/archive');
    expect(dockerignore).toContain('local-archive');
  });

  it('keeps local secret and legacy key files out of git', () => {
    const gitignore = readFileSync('.gitignore', 'utf8');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

    expect(gitignore).toContain('exa_api_key*.txt');
    expect(gitignore).toContain('*.deprecated');
    expect(gitignore).toContain('*.old');
    expect(gitignore).toContain('*.backup');
    expect(gitignore).toContain('config/secrets.json');
    expect(gitignore).toContain('local-archive/');
    expect(packageJson.scripts['scan:secrets']).toBe('node scripts/scan-secrets.mjs');
    expect(readFileSync('scripts/scan-secrets.mjs', 'utf8')).toContain('Potential secret material found');
  });

  it('keeps one-time cleanup assets in archive folders', () => {
    const docsReadme = readFileSync('docs/README.md', 'utf8');
    const scriptsReadme = readFileSync('scripts/README.md', 'utf8');

    expect(docsReadme).toContain('archive/');
    expect(scriptsReadme).toContain('archive/');
    expect(readFileSync('scripts/archive/refactor-project.bat', 'utf8')).toContain('项目结构规范化');
    expect(readFileSync('scripts/archive/cleanup-project.ps1', 'utf8')).toContain('Cleaning up remaining files');
  });

  it('provides Docker volume backup and restore scripts for the SQLite state', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const backup = readFileSync('scripts/backup-state.mjs', 'utf8');
    const restore = readFileSync('scripts/restore-state.mjs', 'utf8');

    expect(packageJson.scripts['backup:docker']).toBe('node scripts/backup-state.mjs');
    expect(packageJson.scripts['restore:docker']).toBe('node scripts/restore-state.mjs');
    expect(backup).toContain("['compose', '-f', composeFile, 'stop', serviceName]");
    expect(backup).toContain('tar -czf -');
    expect(restore).toContain("['compose', '-f', composeFile, 'stop', serviceName]");
    expect(restore).toContain('tar -xzf - -C /data');
  });

  it('pins the developer runtime and automates CI plus Docker Hub publishing', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const publish = readFileSync('.github/workflows/docker-publish.yml', 'utf8');

    expect(packageJson.scripts.verify).toBe('npm run scan:secrets && npm run lint && npm test && npm audit --audit-level=high && npm run build');
    expect(ci).toContain('node-version: 22.x');
    expect(ci).toContain('npm run verify');
    expect(ci).toContain('docker compose build');
    expect(publish).toContain('al1ya/exa-reverse-proxy');
    expect(publish).toContain('platforms: linux/amd64,linux/arm64');
  });

  it('mounts the key file at the same path the container reads', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8');

    expect(compose).toContain('EXA_KEYS_FILE: /run/secrets/exa_api_key.txt');
    expect(compose).toContain('./exa_api_key.txt:/run/secrets/exa_api_key.txt:ro');
  });

  it('keeps the Docker Hub deployment compose ready for one-command VPS starts', () => {
    const compose = readFileSync('docker-compose.deploy.yml', 'utf8');

    expect(compose).toContain('image: al1ya/exa-reverse-proxy:latest');
    expect(compose).toContain('"127.0.0.1:8787:8787"');
    expect(compose).toContain('EXA_KEYS_FILE: /run/secrets/exa_api_key.txt');
    expect(compose).toContain('./exa_api_key.txt:/run/secrets/exa_api_key.txt:ro');
  });

  it('keeps user-facing docs aligned with the current verification state', () => {
    const docs = [
      'docs/README.md',
      'docs/DEPLOYMENT.md',
      'docs/DEPLOYMENT_CHECKLIST.md',
      'docs/DOCKER_TROUBLESHOOTING.md',
      'docs/QUICK_START.md'
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    const scripts = [
      'scripts/prepare-deployment.bat',
      'scripts/publish-docker-hub.bat'
    ].map((path) => readFileSync(path, 'utf8')).join('\n');

    expect(docs).not.toMatch(/(?:测试结果|测试通过|所有测试通过)[^\n]*\d+\/\d+/);
    expect(docs).not.toContain('5 个高危漏洞');
    expect(docs).not.toContain('98HfFe54T6qRi4Z3H');
    expect(docs).toContain('docs\\archive\\OPTIMIZATIONS_SUMMARY.md');
    expect(scripts).toContain('docker-compose.deploy.yml');
  });
});
