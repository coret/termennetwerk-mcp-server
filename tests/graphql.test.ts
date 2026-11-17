import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphqlClient } from '../src/upstream/graphql.ts';

type Captured = { headers: Headers; body: any };

function fakeFetch(response: unknown, captured: Captured[]): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

test('terms sends User-Agent and never sends limit', async () => {
  const captured: Captured[] = [];
  const client = createGraphqlClient({ fetch: fakeFetch({ data: { terms: [] } }, captured) });
  const result = await client.terms({ sources: ['x'], query: 'fiets' });
  assert.equal(captured.length, 1);
  assert.match(captured[0].headers.get('user-agent') ?? '', /^termennetwerk-mcp-server\//);
  assert.equal('limit' in captured[0].body.variables, false);
  assert.deepEqual(result, { data: [], errors: [] });
});

test('partial GraphQL errors are returned, not thrown', async () => {
  const captured: Captured[] = [];
  const one = {
    source: { uri: 'x', name: 'X' },
    responseTimeMs: 5,
    result: { __typename: 'Terms', terms: [] },
  };
  const client = createGraphqlClient({
    fetch: fakeFetch({ data: { terms: [one] }, errors: [{ message: 'boom' }] }, captured),
  });
  const result = await client.terms({ sources: ['x'], query: 'fiets' });
  assert.deepEqual(result.errors, ['boom']);
  assert.equal(result.data.length, 1);
});

test('sources sends the Accept-Language header', async () => {
  const captured: Captured[] = [];
  const client = createGraphqlClient({ fetch: fakeFetch({ data: { sources: [] } }, captured) });
  await client.sources('en');
  assert.equal(captured[0].headers.get('accept-language'), 'en');
});
