import { Pool, request as undiciRequest, type Dispatcher } from 'undici';

export type UpstreamResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Dispatcher.ResponseData['body'];
};

export type PoolStats = {
  connected: number;
  free: number;
  queued: number;
  running: number;
  pending: number;
  size: number;
};

let pool: Pool | null = null;

export function getPoolStats(): PoolStats | null {
  if (!pool) return null;
  const stats = pool.stats;
  return {
    connected: stats.connected,
    free: stats.free,
    queued: stats.queued,
    running: stats.running,
    pending: stats.pending,
    size: stats.size
  };
}

export function initUpstreamPool(baseUrl: string, options?: { connections?: number; keepAliveTimeout?: number }): void {
  if (pool) return;
  pool = new Pool(baseUrl, {
    connections: options?.connections ?? 128,
    pipelining: 1,
    keepAliveTimeout: options?.keepAliveTimeout ?? 30_000,
    keepAliveMaxTimeout: 600_000
  });
}

export function closeUpstreamPool(): void {
  if (!pool) return;
  pool.close();
  pool = null;
}

export async function callUpstream(options: {
  baseUrl: string;
  pathAndQuery: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | null;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<UpstreamResponse> {
  const url = new URL(options.pathAndQuery, options.baseUrl);

  // Combine external signal (client disconnect) with internal timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener('abort', () => controller.abort(options.signal!.reason), { once: true });
    }
  }

  try {
    const requestOptions = {
      method: options.method as Dispatcher.HttpMethod,
      headers: options.headers,
      body: options.body ?? undefined,
      signal: controller.signal
    };

    const response = pool
      ? await pool.request({ origin: url.origin, path: url.pathname + url.search, ...requestOptions })
      : await undiciRequest(url, requestOptions);

    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body
    };
  } finally {
    clearTimeout(timer);
  }
}
