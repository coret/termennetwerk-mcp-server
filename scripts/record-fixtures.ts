/**
 * Records live upstream responses into tests/fixtures/. Run with `npm run record`.
 * Fixtures are the raw upstream payloads (GraphQL `data.*` or reconciliation JSON).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createGraphqlClient } from '../src/upstream/graphql.js';
import { config } from '../src/config.js';

const dir = new URL('../tests/fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
const save = (name: string, value: unknown) => {
  writeFileSync(new URL(name, dir), JSON.stringify(value, null, 2) + '\n');
  console.log('recorded', name);
};

const CHT = 'https://data.cultureelerfgoed.nl/term/id/cht';
const RKD = 'https://data.rkd.nl/rkdartists';
const AAT = 'http://vocab.getty.edu/aat';
const WIKIDATA_ALL = 'https://www.wikidata.org#entities-all';
const NOPE = 'https://example.org/nope';

const gql = createGraphqlClient();

async function form(path: string, field: string, value: unknown, lang: 'nl' | 'en') {
  const res = await fetch(`${config.API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept-Language': lang,
      'User-Agent': config.USER_AGENT,
    },
    body: new URLSearchParams({ [field]: JSON.stringify(value) }),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

save('sources.nl.json', await gql.sources('nl'));

const cht = await gql.terms({ sources: [CHT], query: 'fiets' });
save('terms.cht.fiets.json', cht);
save('terms.rkd.rembrandt.json', await gql.terms({ sources: [RKD], query: 'Rembrandt' }));
save('terms.aat.nl-en.json', await gql.terms({ sources: [AAT], query: 'glas', languages: ['nl', 'en'], timeoutMs: 45000 }));

const timeout = await gql.terms({ sources: [WIKIDATA_ALL], query: 'molen', timeoutMs: 1 });
// Mixed fixture: one successful source (CHT) next to one failed source.
const mixed = { data: [cht.data[0], ...timeout.data], errors: timeout.errors } as any;
if (!timeout.data.some((r) => r?.result && 'message' in r.result)) {
  mixed.data[1].result = { __typename: 'TimeoutError', message: 'Source timed out after 1ms' };
  mixed._note = 'second result hand-edited into a TimeoutError';
}
save('terms.timeout.json', mixed);

const firstCht = (cht.data[0]?.result as any)?.terms?.[0]?.uri as string;
save('lookup.mixed.json', await gql.lookup({ uris: [firstCht, NOPE] }));

const reconcilePath = `/reconcile/${RKD}`;
save('reconcile.rkd.rembrandt.nl.json', await form(reconcilePath, 'queries', { q0: { query: 'Rembrandt' } }, 'nl'));
save('reconcile.rkd.rembrandt.en.json', await form(reconcilePath, 'queries', { q0: { query: 'Rembrandt' } }, 'en'));
save(
  'reconcile.rkd.person.json',
  await form(
    reconcilePath,
    'queries',
    { q0: { query: 'Rembrandt', properties: [{ pid: 'birthDates', v: '1606' }] } },
    'nl',
  ),
);
save(
  'extend.json',
  await form(
    '/extend',
    'extend',
    { ids: ['https://data.rkd.nl/artists/66219', firstCht, NOPE], properties: [{ id: 'prefLabels' }, { id: 'broaderTerms' }] },
    'nl',
  ),
);
