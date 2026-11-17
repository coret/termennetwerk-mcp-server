import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  flattenTermsResults,
  flattenLookup,
  fitBudget,
  hasErrors,
  type CompactTerm,
  type SourceResult,
} from '../src/flatten.ts';

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function assertNoEmpty(value: unknown, path = '$'): void {
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
    assert.fail(`empty value at ${path}`);
  }
  if (Array.isArray(value)) value.forEach((v, i) => assertNoEmpty(v, `${path}[${i}]`));
  else if (typeof value === 'object' && value) {
    const entries = Object.entries(value);
    if (entries.length === 0) assert.fail(`empty object at ${path}`);
    for (const [k, v] of entries) assertNoEmpty(v, `${path}.${k}`);
  }
}

test('re-ranks so the exact prefLabel match comes first, before cutting to limit', () => {
  const [rkd] = flattenTermsResults(fx('terms.rkd.rembrandt.json').data, 'Rembrandt', 3);
  assert.equal(rkd.terms.length, 3);
  assert.equal(rkd.terms[0].uri, 'https://data.rkd.nl/artists/66219');
  assert.equal(rkd.total, 19);
});

test('plain terms have no empty fields', () => {
  const [cht] = flattenTermsResults(fx('terms.cht.fiets.json').data, 'fiets', 100);
  assert.ok(cht.terms.length > 0);
  for (const t of cht.terms) {
    assert.ok(t.uri);
    assertNoEmpty(t);
  }
});

test('translated labels become a language map', () => {
  const [aat] = flattenTermsResults(fx('terms.aat.nl-en.json').data, 'glas', 20);
  assert.equal(aat.ok, true);
  const t = aat.terms[0];
  assert.equal(Array.isArray(t.prefLabel), false);
  const labels = t.prefLabel as Record<string, string[]>;
  assert.ok(labels.nl || labels.en);
  assertNoEmpty(t);
});

test('person summary is compact', () => {
  const [rkd] = flattenTermsResults(fx('terms.rkd.rembrandt.json').data, 'Rembrandt', 1);
  const p = rkd.terms[0].person!;
  assert.equal(p.birthDate, '1606-07-15/1607');
  assert.deepEqual(p.birthPlace, [{ uri: 'https://data.rkd.nl/thesaurus/11', name: ['Leiden (stad)'] }]);
  assert.ok(p.occupations?.includes('schilder'));
});

test('a failed source is reported next to a successful one', () => {
  const results = flattenTermsResults(fx('terms.timeout.json').data, 'molen', 20);
  const failed = results.find((r) => !r.ok)!;
  const ok = results.find((r) => r.ok)!;
  assert.ok(failed.error && failed.error.length > 0);
  assert.deepEqual(failed.terms, []);
  assert.ok(ok.terms.length > 0);
  assert.equal(hasErrors(results), true);
  assert.equal(hasErrors([ok]), false);
});

test('lookup: known URI resolves, unknown URI reports an error', () => {
  const items = flattenLookup(fx('lookup.mixed.json').data);
  const known = items.find((i) => i.uri.startsWith('https://data.cultureelerfgoed.nl'))!;
  const unknown = items.find((i) => i.uri === 'https://example.org/nope')!;
  assert.equal(known.ok, true);
  assert.ok(known.term?.prefLabel);
  assert.equal(known.source?.name, 'Cultuurhistorische Thesaurus');
  assert.equal(unknown.ok, false);
  assert.ok(unknown.error);
  assert.equal(unknown.term, undefined);
});

test('fitBudget truncates large payloads and leaves small ones alone', () => {
  const term = (i: number): CompactTerm => ({ uri: `https://x/${i}`, definition: ['x'.repeat(480)] });
  const results: SourceResult[] = Array.from({ length: 10 }, (_, s) => ({
    source: { uri: `s${s}`, name: `S${s}` },
    ok: true,
    total: 100,
    terms: Array.from({ length: 100 }, (_, i) => term(i)),
  }));
  const big = fitBudget({ results }, (p) => p.results.map((r) => r.terms), 60_000);
  assert.ok(JSON.stringify(big).length <= 60_000);
  assert.equal(big.truncated, true);
  assert.match(big.note ?? '', /limit|narrow/i);

  const small = fitBudget({ results: results.slice(0, 1).map((r) => ({ ...r, terms: r.terms.slice(0, 2) })) },
    (p) => p.results.map((r) => r.terms), 60_000);
  assert.equal(small.truncated, undefined);
  assert.equal(small.results[0].terms.length, 2);
});
