#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

const composeFile = readOption('--compose-file', 'docker-compose.deploy.yml');
const serviceName = readOption('--service', 'exa-proxy');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = resolve(firstPositional() ?? `backups/exa-proxy-state-${timestamp}.tar.gz`);
const noRestart = args.includes('--no-restart');

mkdirSync(dirname(outputPath), { recursive: true });

const stopArgs = ['compose', '-f', composeFile, 'stop', serviceName];
const startArgs = ['compose', '-f', composeFile, 'up', '-d', serviceName];
const archiveCommand = [
  'set -eu',
  'cd /data',
  'test -f exa-proxy.sqlite',
  'tar -czf - exa-proxy.sqlite exa-proxy.sqlite-wal exa-proxy.sqlite-shm 2>/dev/null || tar -czf - exa-proxy.sqlite'
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
    archiveCommand
  ], { encoding: null, maxBuffer: 256 * 1024 * 1024 });

  if (result.stderr?.length) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`state archive failed with exit code ${result.status ?? 'unknown'}`);
  }

  writeFileSync(outputPath, result.stdout);
  console.log(`Backup written to ${outputPath}`);
} finally {
  if (restart) runDocker(startArgs);
}
