import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createReconcileClient,
  reconcileRequestUrl,
  RECONCILE_PIDS,
  EXTEND_PROPERTIES,
} from '../src/upstream/reconcile.ts';
import { flattenReconcile, flattenExtend } from '../src/reconcileFlatten.ts';

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const BASE = 'https://termennetwerk-api.netwerkdigitaalerfgoed.nl/reconcile/';

test('property lists match the live API', () => {
  assert.equal(RECONCILE_PIDS.length, 13);
  assert.equal(EXTEND_PROPERTIES.length, 26);
});

test('a literal # in the source URI is percent-encoded, an existing %23 is kept', () => {
  const literal = reconcileRequestUrl(`${BASE}http://vocab.getty.edu/aat#materials`);
  assert.equal(literal, `${BASE}http://vocab.getty.edu/aat%23materials`);
  assert.equal(new URL(literal).hash, '');
  const encoded = reconcileRequestUrl(`${BASE}http://vocab.getty.edu/aat%23materials`);
  assert.equal(encoded, `${BASE}http://vocab.getty.edu/aat%23materials`);
});

test('reconcile posts an object keyed q0..qN with Accept-Language', async () => {
  const captured: { url: string; headers: Headers; body: URLSearchParams }[] = [];
  const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: new URLSearchParams(String(init?.body)),
    });
    return new Response('{"q0":{"result":[]},"q1":{"result":[]}}', {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const client = createReconcileClient({ fetch: fakeFetch });
  await client.reconcile(`${BASE}x`, [{ query: 'a' }, { query: 'b', limit: 3 }], 'en');
  const queries = JSON.parse(captured[0].body.get('queries')!);
  assert.deepEqual(Object.keys(queries), ['q0', 'q1']);
  assert.equal(queries.q1.limit, 3);
  assert.equal(captured[0].headers.get('accept-language'), 'en');
  assert.match(captured[0].headers.get('user-agent') ?? '', /^termennetwerk-mcp-server\//);
});

test('Rembrandt is the matching top candidate', () => {
  const [q] = flattenReconcile(fx('reconcile.rkd.rembrandt.nl.json'), [{ query: 'Rembrandt' }]);
  assert.equal(q.query, 'Rembrandt');
  const top = q.candidates[0];
  assert.equal(top.id, 'https://data.rkd.nl/artists/66219');
  assert.equal(top.score, 100);
  assert.equal(top.match, true);
  assert.ok(top.type.includes('https://schema.org/Person'));
});

test('empty English names fall back to the description', () => {
  const [q] = flattenReconcile(fx('reconcile.rkd.rembrandt.en.json'), [{ query: 'Rembrandt' }]);
  assert.ok(q.candidates.length > 0);
  for (const c of q.candidates) assert.notEqual(c.name, '');
});

test('match is true only for score 100 or a single candidate when upstream gives none', () => {
  const raw = {
    q0: { result: [{ id: 'a', name: 'A', type: [], score: 90 }, { id: 'b', name: 'B', type: [], score: 50 }] },
    q1: { result: [{ id: 'c', name: 'C', type: [], score: 40 }] },
  };
  const [q0, q1] = flattenReconcile(raw, [{ query: 'x' }, { query: 'y' }]);
  assert.deepEqual(q0.candidates.map((c) => c.match), [false, false]);
  assert.equal(q1.candidates[0].match, true);
});

test('person query keeps the matching features', () => {
  const [q] = flattenReconcile(fx('reconcile.rkd.person.json'), [
    { query: 'Rembrandt', properties: [{ pid: 'birthDates', v: '1606' }] },
  ]);
  assert.ok(q.candidates[0].features?.some((f) => f.id === 'birthDates'));
});

test('extend reports rows and the ids upstream did not return', () => {
  const ids = [
    'https://data.rkd.nl/artists/66219',
    'https://data.cultureelerfgoed.nl/term/id/cht/2139ed66-83ef-4533-9a2c-ad51891ea10a',
    'https://example.org/nope',
  ];
  const out = flattenExtend(fx('extend.json'), ids);
  assert.deepEqual(out.rows['https://data.rkd.nl/artists/66219'].prefLabels, ['Rembrandt']);
  assert.deepEqual(out.rows[ids[1]].broaderTerms, [
    { id: 'https://data.cultureelerfgoed.nl/term/id/cht/4242ae9e-ffa8-43be-9a08-e6fe9ca87da2', name: 'lichamelijke activiteiten' },
  ]);
  assert.deepEqual(out.notFound, ['https://example.org/nope']);
});
