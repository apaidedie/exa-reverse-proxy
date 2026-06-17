import { describe, expect, it } from 'vitest';
import { classifyError, classifyStatus, parseRetryAfterMs, retryBackoffMs } from '../src/retry.js';

describe('retry', () => {
  it('classifies retryable and non-retryable statuses', () => {
    expect(classifyStatus(429)).toEqual({ retryable: true, reason: 'rate_limit' });
    expect(classifyStatus(402)).toEqual({ retryable: true, reason: 'credits_exhausted' });
    expect(classifyStatus(503)).toEqual({ retryable: true, reason: 'transient_status' });
    expect(classifyStatus(401)).toEqual({ retryable: false, reason: 'client_status' });
  });

  it('classifies timeout-like errors', () => {
    expect(classifyError(Object.assign(new Error('timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toEqual({
      retryable: true,
      reason: 'timeout'
    });
  });

  it('parses retry-after and backoff defaults', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(retryBackoffMs([100, 250], 0)).toBe(100);
    expect(retryBackoffMs([100, 250], 4)).toBe(250);
  });
});
