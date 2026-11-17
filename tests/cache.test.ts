import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { cacheKey, createCache, withCache, type Cache } from '../src/cache.ts';

const silent = pino({ level: 'silent' });

function memoryCache(): Cache {
  const store = new Map<string, unknown>();
  return {
    available: true,
    async get<T>(key: string) {
      return (store.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown) {
      store.set(key, value);
    },
    async close() {},
  };
}

test('cache keys ignore argument order and source order', () => {
  assert.equal(
    cacheKey('search_terms', { sources: ['b', 'a'], query: 'x' }),
    cacheKey('search_terms', { query: 'x', sources: ['a', 'b'] }),
  );
  assert.match(cacheKey('search_terms', { query: 'x' }), /^tn:search_terms:[0-9a-f]{40}$/);
});

test('different queries give different keys; reconcile query order matters', () => {
  assert.notEqual(cacheKey('search_terms', { query: 'x' }), cacheKey('search_terms', { query: 'y' }));
  assert.notEqual(
    cacheKey('reconcile', { queries: [{ query: 'a' }, { query: 'b' }] }),
    cacheKey('reconcile', { queries: [{ query: 'b' }, { query: 'a' }] }),
  );
});

test('unreachable Redis degrades to no cache without throwing', async () => {
  const cache = createCache('redis://127.0.0.1:1/9', silent);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(cache.available, false);
  assert.equal(await cache.get('k'), null);
  await cache.set('k', { a: 1 }, 10);
  await cache.close();
});

test('withCache stores only cacheable results', async () => {
  const cache = memoryCache();
  let calls = 0;
  const produce = (cacheable: boolean) => async () => {
    calls++;
    return { value: { n: calls }, cacheable };
  };
  const a = await withCache(cache, 'k1', 60, produce(true));
  const b = await withCache(cache, 'k1', 60, produce(true));
  assert.equal(calls, 1);
  assert.equal(a.hit, false);
  assert.equal(b.hit, true);
  assert.deepEqual(b.value, { n: 1 });

  calls = 0;
  await withCache(cache, 'k2', 60, produce(false));
  await withCache(cache, 'k2', 60, produce(false));
  assert.equal(calls, 2);
});
