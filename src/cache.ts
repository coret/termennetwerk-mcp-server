import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Logger } from './log.js';

export interface Cache {
  readonly available: boolean;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

/** Argument names whose string arrays are order-insensitive. */
const SORTED_ARRAYS = new Set(['sources', 'languages', 'genres', 'uris', 'ids', 'properties']);

function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v));
    return key && SORTED_ARRAYS.has(key) && items.every((v) => typeof v === 'string')
      ? [...(items as string[])].sort()
      : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k], k)]),
    );
  }
  return value;
}

export function cacheKey(tool: string, args: unknown): string {
  const hash = createHash('sha1').update(JSON.stringify(canonical(args))).digest('hex');
  return `tn:${tool}:${hash}`;
}

/** Redis-backed cache; every failure degrades to "no cache" instead of failing the request. */
export function createCache(url: string | null, log: Logger): Cache {
  let available = false;
  let redis: Redis | null = null;

  if (url) {
    redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    redis.on('ready', () => {
      available = true;
      log.info('Redis connected');
    });
    redis.on('error', (err: Error) => {
      if (available) log.warn({ err: err.message }, 'Redis disconnected, running uncached');
      available = false;
    });
    redis.connect().catch((err: Error) => {
      available = false;
      log.warn({ err: err.message }, 'Redis unavailable, running uncached');
    });
  }

  return {
    get available() {
      return available;
    },
    async get<T>(key: string): Promise<T | null> {
      if (!available || !redis) return null;
      try {
        const raw = await redis.get(key);
        return raw === null ? null : (JSON.parse(raw) as T);
      } catch {
        return null;
      }
    },
    async set(key, value, ttlSeconds) {
      if (!available || !redis) return;
      try {
        await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      } catch {
        /* degraded: ignore */
      }
    },
    async close() {
      if (redis) redis.disconnect();
    },
  };
}

export async function withCache<T>(
  cache: Cache,
  key: string,
  ttlSeconds: number,
  produce: () => Promise<{ value: T; cacheable: boolean }>,
): Promise<{ value: T; hit: boolean }> {
  const cached = await cache.get<T>(key);
  if (cached !== null) return { value: cached, hit: true };
  const { value, cacheable } = await produce();
  if (cacheable) await cache.set(key, value, ttlSeconds);
  return { value, hit: false };
}
