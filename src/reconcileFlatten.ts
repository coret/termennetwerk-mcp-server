import type { RawBatch, RawExtend, ReconcileQuery } from './upstream/reconcile.js';

export interface Candidate {
  id: string;
  name: string;
  score: number;
  match: boolean;
  type: string[];
  description?: string;
  features?: { id: string; value: number | string | boolean }[];
}

export interface ReconcileResult {
  query: string;
  candidates: Candidate[];
}

export type ExtendValue = string | { id: string; name?: string };

export interface ExtendResult {
  rows: Record<string, Record<string, ExtendValue[]>>;
  notFound: string[];
}

export function flattenReconcile(raw: RawBatch, queries: ReconcileQuery[]): ReconcileResult[] {
  return queries.map((q, i) => {
    const result = raw[`q${i}`]?.result ?? [];
    const candidates = result.map((c): Candidate => {
      const out: Candidate = {
        id: c.id,
        // With Accept-Language: en some sources return an empty name; the
        // description carries the label variants, the id is the last resort.
        name: c.name?.trim() || c.description?.split(' • ')[0]?.trim() || c.id,
        score: c.score,
        // Upstream sets `match` for property queries; otherwise only a perfect score counts.
        match: c.match ?? c.score >= 100,
        type: (c.type ?? []).map((t) => t.id),
      };
      if (c.description) out.description = c.description;
      if (c.features?.length) out.features = c.features;
      return out;
    });
    return { query: q.query, candidates };
  });
}

export function flattenExtend(raw: RawExtend, ids: string[]): ExtendResult {
  const rows: ExtendResult['rows'] = {};
  const notFound: string[] = [];
  for (const id of ids) {
    const row = raw.rows?.[id];
    if (!row) {
      notFound.push(id);
      continue;
    }
    rows[id] = Object.fromEntries(
      Object.entries(row).map(([prop, values]) => [
        prop,
        (values ?? []).flatMap((v): ExtendValue[] => {
          if (!v) return [];
          if (v.str !== undefined) return [v.str];
          if (v.id) return [v.name ? { id: v.id, name: v.name } : { id: v.id }];
          return [];
        }),
      ]),
    );
  }
  return { rows, notFound };
}

export type FittedExtend = ExtendResult & { truncated?: true; note?: string; omitted?: string[] };

/**
 * Keeps the extend response within `maxBytes` by dropping whole rows from the end and
 * listing their ids in `omitted`. `notFound` is never trimmed.
 */
export function fitExtend(result: ExtendResult, maxBytes: number): FittedExtend {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (size(result) <= maxBytes) return result;
  const out: FittedExtend = {
    rows: { ...result.rows },
    notFound: result.notFound,
    truncated: true,
    note: 'Response truncated to stay within the size budget. Rows for the ids in `omitted` were left out: request fewer ids or fewer properties.',
    omitted: [],
  };
  const ids = Object.keys(out.rows);
  while (size(out) > maxBytes && ids.length) {
    const id = ids.pop()!;
    delete out.rows[id];
    out.omitted!.unshift(id);
  }
  return out;
}
