#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);

function readOption(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function firstPositional() {
  return args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
}

function runDocker(dockerArgs, options = {}) {
  const result = spawnSync('docker', dockerArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`docker ${dockerArgs.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
  return result;
}

const archiveArg = firstPositional();
if (!archiveArg) {
  console.error('Usage: npm run restore:docker -- <backup.tar.gz> --yes');
  process.exit(1);
}
if (!args.includes('--yes')) {
  console.error('Restore replaces /data/exa-proxy.sqlite* in the Docker volume. Re-run with --yes to confirm.');
  process.exit(1);
}

const archivePath = resolve(archiveArg);
if (!existsSync(archivePath)) {
  console.error(`Backup archive not found: ${archivePath}`);
  process.exit(1);
}

const composeFile = readOption('--compose-file', 'docker-compose.deploy.yml');
const serviceName = readOption('--service', 'exa-proxy');
const noRestart = args.includes('--no-restart');
const archive = readFileSync(archivePath);

const stopArgs = ['compose', '-f', composeFile, 'stop', serviceName];
const startArgs = ['compose', '-f', composeFile, 'up', '-d', serviceName];
const restoreCommand = [
  'set -eu',
  'mkdir -p /data',
  'rm -f /data/exa-proxy.sqlite /data/exa-proxy.sqlite-wal /data/exa-proxy.sqlite-shm',
  'tar -xzf - -C /data'
].join('; ');

let restart = false;
try {
  runDocker(stopArgs);
  restart = !noRestart;

  const result = spawnSync('docker', [
    'compose',
    '-f',
    composeFile,
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'sh',
    serviceName,
    '-c',
    restoreCommand
  ], { input: archive, stdio: ['pipe', 'inherit', 'inherit'] });

  if (result.status !== 0) {
    throw new Error(`state restore failed with exit code ${result.status ?? 'unknown'}`);
  }

  console.log(`Backup restored from ${archivePath}`);
} finally {
  if (restart) runDocker(startArgs);
}
