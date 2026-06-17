import { describe, expect, it } from 'vitest';
import { createStateStore } from '../src/state.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('StateStore', () => {
  it('records key attempts, request logs, cooldowns, and affinity mappings', () => {
    const state = createStateStore(':memory:', [{ id: 'a', value: 'secret', weight: 1, enabled: true }]);

    state.recordAttempt({ keyId: 'a', status: 200, success: true, latencyMs: 12, retry: false, reason: 'ok' });
    state.setCooldown('a', 1234, 'rate_limit');
    state.setAffinity('agent_run', 'run_123', 'a');
    state.recordRequestLog({
      requestId: 'req_1',
      tokenId: 'tok_abc',
      method: 'POST',
      path: '/search',
      status: 200,
      keyIds: ['a'],
      attempts: 1,
      latencyMs: 15,
      errorCode: null
    });

    expect(state.listKeyStats()[0]).toMatchObject({ id: 'a', totalRequests: 1, successCount: 1, cooldownUntil: 1234 });
    expect(state.getAffinity('agent_run', 'run_123')).toBe('a');
    expect(state.listRequestLogs(10)[0]).toMatchObject({ requestId: 'req_1', path: '/search', keyIds: ['a'] });
    state.close();
  });

  it('preserves existing DB keys across restarts and seeds new config keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exa-state-'));
    const dbPath = join(dir, 'state.sqlite');

    try {
      const state = createStateStore(dbPath, [{ id: 'old_key', value: 'old-secret', weight: 1, enabled: true }]);
      state.recordAttempt({ keyId: 'old_key', status: 401, success: false, latencyMs: 8, retry: false, reason: 'client_status' });
      state.close();

      const nextState = createStateStore(dbPath, [{ id: 'new_key', value: 'new-secret', weight: 1, enabled: true }]);
      const keyIds = nextState.listKeyStats().map((key) => key.id);
      expect(keyIds).toContain('old_key');
      expect(keyIds).toContain('new_key');
      nextState.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('traces request logs by request id and summarizes recent failures for a key', () => {
    const state = createStateStore(':memory:', [
      { id: 'a', value: 'secret-a', weight: 1, enabled: true },
      { id: 'b', value: 'secret-b', weight: 1, enabled: true }
    ]);

    state.recordRequestLog({
      requestId: 'req_trace_1',
      tokenId: 'tok_client',
      method: 'POST',
      path: '/search',
      status: 503,
      keyIds: ['a', 'b'],
      attempts: 2,
      latencyMs: 120,
      errorCode: 'upstream_5xx'
    });
    state.recordRequestLog({
      requestId: 'req_trace_1',
      tokenId: 'tok_client',
      method: 'POST',
      path: '/search',
      status: 200,
      keyIds: ['b'],
      attempts: 1,
      latencyMs: 60,
      errorCode: null
    });
    state.recordRequestLog({
      requestId: 'req_other',
      tokenId: 'tok_client',
      method: 'POST',
      path: '/contents',
      status: 429,
      keyIds: ['a'],
      attempts: 1,
      latencyMs: 40,
      errorCode: 'rate_limit'
    });

    const trace = state.getRequestTrace('req_trace_1');
    const failures = state.keyFailureSummary('a', 10);

    expect(trace.map((log) => log.requestId)).toEqual(['req_trace_1', 'req_trace_1']);
    expect(trace.map((log) => log.status)).toEqual([503, 200]);
    expect(JSON.stringify(trace)).not.toContain('secret-a');
    expect(failures).toMatchObject({
      keyId: 'a',
      totalFailures: 2,
      reasons: { upstream_5xx: 1, rate_limit: 1 },
      samples: expect.any(Array)
    });
    expect(failures.samples[0]).toMatchObject({ requestId: 'req_other', status: 429, errorCode: 'rate_limit' });
    state.close();
  });

  it('filters admin audit logs for export use cases', () => {
    const state = createStateStore(':memory:', [{ id: 'a', value: 'secret', weight: 1, enabled: true }]);

    state.recordAdminAudit({ actorTokenId: 'tok_admin', action: 'login', success: true, detail: 'ok' });
    state.recordAdminAudit({ actorTokenId: 'tok_admin', action: 'test_key', targetId: 'a', success: false, detail: 'HTTP 503' });

    const failures = state.listAdminAuditLogs({ limit: 10, action: 'test', success: false });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ action: 'test_key', targetId: 'a', success: false });
    state.close();
  });

  it('manages persistent keys with encrypted values via CRUD operations', () => {
    const state = createStateStore(':memory:', []);

    // Initially empty
    expect(state.listPersistentKeys()).toHaveLength(0);
    expect(state.keyCount()).toBe(0);

    // Add keys with encrypted values
    state.upsertKey('k1', 'encrypted-value-1', 1, true);
    state.upsertKey('k2', 'encrypted-value-2', 2, true);

    expect(state.keyCount()).toBe(2);
    expect(state.listPersistentKeys()).toEqual([
      { id: 'k1', value: 'encrypted-value-1', weight: 1, enabled: true },
      { id: 'k2', value: 'encrypted-value-2', weight: 2, enabled: true }
    ]);

    // Update existing key — upsertKey updates value and weight but preserves enabled state
    state.upsertKey('k1', 'updated-encrypted-1', 3, false);
    expect(state.getKeyValue('k1')).toBe('updated-encrypted-1');
    expect(state.listPersistentKeys().find((k) => k.id === 'k1')).toMatchObject({ weight: 3, enabled: true });

    // Enabled changes require setEnabled
    state.setEnabled('k1', false);
    expect(state.listPersistentKeys().find((k) => k.id === 'k1')).toMatchObject({ enabled: false });

    // Delete a key
    state.deleteKey('k2');
    expect(state.keyCount()).toBe(1);
    expect(state.listPersistentKeys().map((k) => k.id)).toEqual(['k1']);
    expect(state.getKeyValue('k2')).toBeNull();

    state.close();
  });
});
