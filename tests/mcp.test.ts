import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type Deps } from '../src/mcp.ts';
import type { Cache } from '../src/cache.ts';
import type { GraphqlClient, TermsArgs } from '../src/upstream/graphql.ts';
import type { ReconcileClient } from '../src/upstream/reconcile.ts';

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function memoryCache(): Cache {
  const store = new Map<string, unknown>();
  return {
    available: true,
    async get<T>(k: string) {
      return (store.get(k) as T) ?? null;
    },
    async set(k: string, v: unknown) {
      store.set(k, v);
    },
    async close() {},
  };
}

function stubDeps() {
  const calls = { terms: [] as TermsArgs[], reconcile: 0, extend: 0 };
  const gql: GraphqlClient = {
    async sources() {
      return fx('sources.nl.json');
    },
    async terms(args) {
      calls.terms.push(args);
      if (args.query === 'molen') return fx('terms.timeout.json');
      if (args.query === 'Rembrandt') return fx('terms.rkd.rembrandt.json');
      return fx('terms.cht.fiets.json');
    },
    async lookup() {
      return fx('lookup.mixed.json');
    },
  };
  const recon: ReconcileClient = {
    async reconcile() {
      calls.reconcile++;
      return fx('reconcile.rkd.rembrandt.nl.json');
    },
    async extend() {
      calls.extend++;
      return fx('extend.json');
    },
  };
  const deps: Deps = { gql, recon, cache: memoryCache(), log: pino({ level: 'silent' }) };
  return { deps, calls };
}

async function connect(deps: Deps) {
  const server = createMcpServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: any) => r.content[0].text as string;

test('exposes exactly the five read-only tools', async () => {
  const client = await connect(stubDeps().deps);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'extend_terms',
    'list_sources',
    'lookup_terms',
    'reconcile',
    'search_terms',
  ]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
});

test('search_terms rejects more than 10 sources without calling upstream', async () => {
  const { deps, calls } = stubDeps();
  const client = await connect(deps);
  const sources = Array.from({ length: 11 }, (_, i) => `s${i}`);
  const r: any = await client.callTool({ name: 'search_terms', arguments: { sources, query: 'x' } });
  assert.equal(r.isError, true);
  assert.equal(calls.terms.length, 0);
});

test('search_terms resolves names, never sends limit, and re-ranks', async () => {
  const { deps, calls } = stubDeps();
  const client = await connect(deps);
  const r: any = await client.callTool({
    name: 'search_terms',
    arguments: { sources: ['RKDartists'], query: 'Rembrandt', limit: 3 },
  });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls.terms[0].sources, ['https://data.rkd.nl/rkdartists']);
  assert.equal('limit' in calls.terms[0], false);
  assert.equal(r.structuredContent.results[0].terms[0].uri, 'https://data.rkd.nl/artists/66219');
  assert.equal(r.structuredContent.results[0].terms.length, 3);
});

test('search_terms with an unknown source explains how to recover', async () => {
  const client = await connect(stubDeps().deps);
  const r: any = await client.callTool({ name: 'search_terms', arguments: { sources: ['RKD'], query: 'x' } });
  assert.equal(r.isError, true);
  assert.match(text(r), /list_sources/);
  assert.match(text(r), /RKDartists/);
});

test('results with a failed source are not cached; clean results are', async () => {
  const { deps, calls } = stubDeps();
  const client = await connect(deps);
  const args = { sources: ['Cultuurhistorische Thesaurus', 'Wikidata: alle entiteiten'], query: 'molen' };
  await client.callTool({ name: 'search_terms', arguments: args });
  await client.callTool({ name: 'search_terms', arguments: args });
  assert.equal(calls.terms.length, 2);

  const clean = { sources: ['Cultuurhistorische Thesaurus'], query: 'fiets' };
  await client.callTool({ name: 'search_terms', arguments: clean });
  await client.callTool({ name: 'search_terms', arguments: clean });
  assert.equal(calls.terms.length, 3);
});

test('reconcile on a source without reconciliation points to search_terms', async () => {
  const { deps, calls } = stubDeps();
  const client = await connect(deps);
  const r: any = await client.callTool({
    name: 'reconcile',
    arguments: { source: 'Wikidata: alle entiteiten', queries: [{ query: 'Rembrandt' }] },
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /search_terms/);
  assert.equal(calls.reconcile, 0);
});

test('reconcile returns the matching candidate', async () => {
  const client = await connect(stubDeps().deps);
  const r: any = await client.callTool({
    name: 'reconcile',
    arguments: { source: 'RKDartists', queries: [{ query: 'Rembrandt' }] },
  });
  const top = r.structuredContent.results[0].candidates[0];
  assert.equal(top.id, 'https://data.rkd.nl/artists/66219');
  assert.equal(top.match, true);
});

test('lookup_terms reports unknown URIs', async () => {
  const client = await connect(stubDeps().deps);
  const r: any = await client.callTool({
    name: 'lookup_terms',
    arguments: { uris: ['https://data.cultureelerfgoed.nl/term/id/cht/2139ed66-83ef-4533-9a2c-ad51891ea10a', 'https://example.org/nope'] },
  });
  const nope = r.structuredContent.results.find((x: any) => x.uri === 'https://example.org/nope');
  assert.equal(nope.ok, false);
});

test('extend_terms reports ids that were not found', async () => {
  const client = await connect(stubDeps().deps);
  const r: any = await client.callTool({
    name: 'extend_terms',
    arguments: {
      ids: ['https://data.rkd.nl/artists/66219', 'https://example.org/nope'],
      properties: ['prefLabels', 'broaderTerms'],
    },
  });
  assert.deepEqual(r.structuredContent.notFound, ['https://example.org/nope']);
});
