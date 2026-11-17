import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  summarizeSources,
  resolveSource,
  resolveSources,
  UnknownSourceError,
} from '../src/sources.ts';

const raw = JSON.parse(readFileSync(new URL('./fixtures/sources.nl.json', import.meta.url), 'utf8'));
const sources = summarizeSources(raw);
const RKD = 'https://data.rkd.nl/rkdartists';

test('summarizes all 58 sources', () => {
  assert.equal(sources.length, 58);
});

test('reconciliation and genre filter features are exposed', () => {
  const rkd = sources.find((s) => s.uri === RKD)!;
  assert.ok(rkd.reconciliationUrl?.includes('/reconcile/'));
  assert.equal(rkd.supportsGenreFilter, false);
  const aat = sources.find((s) => s.uri === 'http://vocab.getty.edu/aat')!;
  assert.equal(aat.supportsGenreFilter, true);
});

test('no summary contains null values', () => {
  for (const s of sources) {
    for (const [k, v] of Object.entries(s)) assert.notEqual(v, null, `${s.name}.${k}`);
  }
});

test('resolves by URI and by case-insensitive name', () => {
  assert.equal(resolveSource(RKD, sources).uri, RKD);
  assert.equal(resolveSource('rkdartists', sources).uri, RKD);
});

test('unknown source throws with suggestions', () => {
  assert.throws(
    () => resolveSource('RKD', sources),
    (err: unknown) =>
      err instanceof UnknownSourceError && err.suggestions.some((s) => s.uri === RKD),
  );
});

test('resolveSources dedupes name and URI of the same source', () => {
  assert.equal(resolveSources(['RKDartists', RKD], sources).length, 1);
});
