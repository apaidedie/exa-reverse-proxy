import { describe, expect, it } from 'vitest';
import { KeyScheduler } from '../src/scheduler.js';

const keys = [
  { id: 'a', value: 'key-a', weight: 1, enabled: true },
  { id: 'b', value: 'key-b', weight: 2, enabled: true }
];

describe('KeyScheduler', () => {
  it('uses weighted round-robin ordering', () => {
    const scheduler = new KeyScheduler(keys, 'weighted_round_robin');
    expect([scheduler.next(Date.now())?.id, scheduler.next(Date.now())?.id, scheduler.next(Date.now())?.id]).toEqual([
      'a',
      'b',
      'b'
    ]);
  });

  it('skips disabled and cooling keys', () => {
    const scheduler = new KeyScheduler(keys, 'round_robin');
    scheduler.setDisabled('a', true);
    scheduler.coolDown('b', Date.now() + 1000, Date.now(), 'rate_limit');
    expect(scheduler.next(Date.now())).toBeUndefined();
    expect(scheduler.next(Date.now() + 1001)?.id).toBe('b');
  });

  it('returns by id only when eligible', () => {
    const scheduler = new KeyScheduler(keys, 'round_robin');
    expect(scheduler.getById('a', Date.now())?.value).toBe('key-a');
    scheduler.setDisabled('a', true);
    expect(scheduler.getById('a', Date.now())).toBeUndefined();
  });

  it('routes more traffic to healthier and lower-latency keys with adaptive weighting', () => {
    const scheduler = new KeyScheduler([
      { id: 'fast_good', value: 'key-fast', weight: 1, enabled: true },
      { id: 'slow_bad', value: 'key-slow', weight: 1, enabled: true }
    ], 'adaptive_weighted');

    scheduler.updateAdaptiveStats([
      {
        id: 'fast_good',
        enabled: true,
        weight: 1,
        totalRequests: 100,
        successCount: 98,
        failureCount: 2,
        retryCount: 0,
        rateLimitCount: 0,
        timeoutCount: 0,
        creditsExhaustedCount: 0,
        value: null,
        cooldownUntil: 0,
        cooldownReason: null,
        lastStatus: 200,
        lastError: null,
        lastLatencyMs: 80,
        lastSuccessAt: Date.now(),
        lastFailureAt: null
      },
      {
        id: 'slow_bad',
        enabled: true,
        weight: 1,
        totalRequests: 100,
        successCount: 62,
        failureCount: 38,
        retryCount: 20,
        rateLimitCount: 12,
        timeoutCount: 6,
        creditsExhaustedCount: 0,
        value: null,
        cooldownUntil: 0,
        cooldownReason: null,
        lastStatus: 503,
        lastError: 'upstream_5xx',
        lastLatencyMs: 2400,
        lastSuccessAt: Date.now(),
        lastFailureAt: Date.now()
      }
    ]);

    const choices = Array.from({ length: 30 }, () => scheduler.next(Date.now())?.id);
    const fastCount = choices.filter((id) => id === 'fast_good').length;
    const slowCount = choices.filter((id) => id === 'slow_bad').length;
    const snapshot = scheduler.snapshot(Date.now());

    expect(fastCount).toBeGreaterThan(slowCount * 3);
    expect(snapshot.find((item) => item.id === 'fast_good')).toMatchObject({ adaptiveWeight: expect.any(Number), adaptiveScore: expect.any(Number) });
    expect(Number(snapshot.find((item) => item.id === 'fast_good')?.adaptiveWeight)).toBeGreaterThan(Number(snapshot.find((item) => item.id === 'slow_bad')?.adaptiveWeight));
  });

  it('hydrates persisted disabled and cooldown state from key stats', () => {
    const now = Date.now();
    const scheduler = new KeyScheduler(keys, 'round_robin');

    scheduler.updateAdaptiveStats([
      {
        id: 'a',
        enabled: false,
        weight: 1,
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        retryCount: 0,
        rateLimitCount: 0,
        timeoutCount: 0,
        creditsExhaustedCount: 0,
        value: null,
        cooldownUntil: 0,
        cooldownReason: null,
        lastStatus: null,
        lastError: null,
        lastLatencyMs: null,
        lastSuccessAt: null,
        lastFailureAt: null
      },
      {
        id: 'b',
        enabled: true,
        weight: 2,
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        retryCount: 0,
        rateLimitCount: 0,
        timeoutCount: 0,
        creditsExhaustedCount: 0,
        value: null,
        cooldownUntil: now + 10_000,
        cooldownReason: 'rate_limit',
        lastStatus: null,
        lastError: null,
        lastLatencyMs: null,
        lastSuccessAt: null,
        lastFailureAt: null
      }
    ]);

    expect(scheduler.next(now)).toBeUndefined();
    expect(scheduler.snapshot(now)).toEqual([
      expect.objectContaining({ id: 'a', enabled: false, coolingDown: false }),
      expect.objectContaining({ id: 'b', enabled: true, coolingDown: true, cooldownReason: 'rate_limit' })
    ]);
    expect(scheduler.next(now + 10_001)?.id).toBe('b');
  });

  it('supports dynamic key management via addKey, removeKey, updateKey, and getKey', () => {
    const scheduler = new KeyScheduler(keys, 'weighted_round_robin');

    // getKey returns key config
    expect(scheduler.getKey('a')?.value).toBe('key-a');

    // addKey adds a new key
    scheduler.addKey({ id: 'c', value: 'key-c', weight: 1, enabled: true });
    expect(scheduler.getKey('c')?.value).toBe('key-c');

    const choicesAfterAdd = Array.from({ length: 12 }, () => scheduler.next(Date.now())?.id);
    expect(choicesAfterAdd).toContain('c');

    // updateKey changes weight (triggers sequence rebuild)
    scheduler.updateKey('c', { weight: 3 });
    expect(scheduler.getKey('c')?.weight).toBe(3);

    // updateKey changes value
    scheduler.updateKey('c', { value: 'key-c-updated' });
    expect(scheduler.getKey('c')?.value).toBe('key-c-updated');

    // removeKey removes the key
    scheduler.removeKey('c');
    expect(scheduler.getKey('c')).toBeUndefined();

    const choicesAfterRemove = Array.from({ length: 10 }, () => scheduler.next(Date.now())?.id);
    expect(choicesAfterRemove).not.toContain('c');
  });
});
