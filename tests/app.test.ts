import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { createApp } from '../src/app.ts';
import type { Deps } from '../src/mcp.ts';

const deps: Deps = {
  gql: {
    async sources() {
      return [];
    },
    async terms() {
      return { data: [], errors: [] };
    },
    async lookup() {
      return { data: [], errors: [] };
    },
  },
  recon: {
    async reconcile() {
      return {};
    },
    async extend() {
      return { rows: {} };
    },
  },
  cache: {
    available: false,
    async get() {
      return null;
    },
    async set() {},
    async close() {},
  },
  log: pino({ level: 'silent' }),
};

const server = createApp(deps, { rateLimitPerMin: 3 }).listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
let id = 0;
const rpc = (method: string, params: object = {}, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });

test('health reports status', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.redis, false);
});

test('foreign Origin is rejected', async () => {
  const res = await rpc('tools/list', {}, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('claude.ai Origin is accepted', async () => {
  const res = await rpc('tools/list', {}, { origin: 'https://claude.ai' });
  assert.equal(res.status, 200);
});

test('initialize and tools/list work statelessly', async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  });
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, 'termennetwerk-mcp-server');
  const list = await rpc('tools/list');
  const body = await list.json();
  assert.equal(body.result.tools.length, 5);
});

test('only tools/call counts toward the rate limit', async () => {
  for (let i = 0; i < 4; i++) assert.notEqual((await rpc('tools/list')).status, 429);
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await rpc('tools/call', { name: 'list_sources', arguments: {} })).status);
  }
  assert.deepEqual(statuses.slice(0, 3).includes(429), false);
  assert.equal(statuses[3], 429);
});

test('JSON-RPC batch arrays are rejected so they cannot bypass the rate limit', async () => {
  const batch = Array.from({ length: 5 }, (_, i) => ({
    jsonrpc: '2.0',
    id: 1000 + i,
    method: 'tools/call',
    params: { name: 'list_sources', arguments: {} },
  }));
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(batch) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, -32600);
});

test('malformed JSON gets a JSON-RPC parse error', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: '{"query":"Secret Name',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, -32700);
  assert.doesNotMatch(JSON.stringify(body), /Secret Name/);
});

test('GET with event-stream is 405, a browser gets the landing page', async () => {
  const sse = await fetch(`${base}/`, { headers: { accept: 'text/event-stream' } });
  assert.equal(sse.status, 405);
  const html = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /mcp-termennetwerk\.coret\.org/);
});

test('the demo animation is served from public/', async () => {
  const res = await fetch(`${base}/termennetwerk-vb1.gif`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/gif');
});

test('the A2A agent card is served on both paths', async () => {
  for (const path of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    const card = await res.json();
    assert.equal(card.protocolVersion, '0.3.0');
    assert.deepEqual(
      card.skills.map((s: { id: string }) => s.id).sort(),
      ['extend_terms', 'list_sources', 'lookup_terms', 'reconcile', 'search_terms'],
    );
  }
});

test('the landing page links all discovery metadata', async () => {
  const html = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
  for (const path of [
    '/.well-known/mcp/server-card.json',
    '/.well-known/mcp.json',
    '/.well-known/agent-card.json',
    '/.well-known/agent.json',
  ]) {
    assert.ok(html.includes(`href="${path}"`), path);
  }
});

test('the landing page has the Links section', async () => {
  const html = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /<h2>Links<\/h2>/);
  for (const url of [
    'https://github.com/coret/termennetwerk-mcp-server',
    'https://termennetwerk.netwerkdigitaalerfgoed.nl/nl',
    'https://termennetwerk-api.netwerkdigitaalerfgoed.nl/',
    'https://docs.nde.nl/services/network-of-terms/',
    'https://www.youtube.com/watch?v=ZjEx1gW5_ws',
  ]) {
    assert.ok(html.includes(`href="${url}"`), url);
  }
});

test('the landing page shows a Prototype label above the title', async () => {
  const html = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /<p class="prototype">Prototype<\/p>\s*<h1>/);
});

test('server card is served', async () => {
  const res = await fetch(`${base}/.well-known/mcp/server-card.json`);
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.equal(card.serverInfo.name, 'io.github.coret/termennetwerk-mcp-server');
});
