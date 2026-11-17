import { config } from '../config.js';
import { upstreamLimiter } from './limiter.js';
import type { CatalogLang } from './graphql.js';

/** Properties the reconciliation service matches on (live `GET /suggest/property`). */
export const RECONCILE_PIDS = [
  'givenNames',
  'familyNames',
  'birthDates',
  'deathDates',
  'birthPlaces',
  'deathPlaces',
  'genders',
  'occupations',
  'nationalities',
  'parents',
  'children',
  'spouses',
  'siblings',
] as const;

/** Data extension properties (live `GET /extend/propose`). */
export const EXTEND_PROPERTIES = [
  'prefLabels',
  'altLabels',
  'scopeNotes',
  'birthDates',
  'deathDates',
  'birthPlaces',
  'deathPlaces',
  'genders',
  'givenNames',
  'familyNames',
  'occupations',
  'nationalities',
  'parents',
  'children',
  'spouses',
  'siblings',
  'placeNames',
  'latitudes',
  'longitudes',
  'countries',
  'placeTypes',
  'broaderTerms',
  'narrowerTerms',
  'relatedTerms',
  'exactMatches',
  'seeAlso',
] as const;

export type ReconcilePid = (typeof RECONCILE_PIDS)[number];
export type ExtendProperty = (typeof EXTEND_PROPERTIES)[number];

export interface ReconcileQuery {
  query: string;
  type?: string;
  limit?: number;
  properties?: { pid: ReconcilePid; v: string }[];
}

export interface RawCandidate {
  id: string;
  name: string;
  type?: { id: string; name?: string }[];
  score: number;
  match?: boolean;
  description?: string;
  features?: { id: string; value: number | string | boolean }[];
}

export type RawBatch = Record<string, { result: RawCandidate[] }>;

export interface RawExtend {
  meta?: { id: string; name?: string }[];
  rows: Record<string, Record<string, ({ str?: string; id?: string; name?: string } | null)[]>>;
}

export interface ReconcileClient {
  reconcile(url: string, queries: ReconcileQuery[], lang: CatalogLang): Promise<RawBatch>;
  extend(ids: string[], properties: ExtendProperty[], lang: CatalogLang): Promise<RawExtend>;
}

/**
 * The source URI is part of the path. Upstream already encodes `#` as `%23` in
 * `features.url`; a literal `#` would turn into a fragment and never reach the server.
 */
export function reconcileRequestUrl(featureUrl: string): string {
  return featureUrl.replaceAll('#', '%23');
}

export function createReconcileClient(opts: { fetch?: typeof fetch } = {}): ReconcileClient {
  const doFetch = opts.fetch ?? fetch;

  async function post<T>(url: string, field: string, value: unknown, lang: CatalogLang): Promise<T> {
    await upstreamLimiter.acquire();
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'Accept-Language': lang,
        'User-Agent': config.USER_AGENT,
      },
      body: new URLSearchParams({ [field]: JSON.stringify(value) }).toString(),
      signal: AbortSignal.timeout(config.LIMITS.RECONCILE_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Upstream ${new URL(url).pathname.split('/')[1]} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  return {
    reconcile(url, queries, lang) {
      const batch = Object.fromEntries(queries.map((q, i) => [`q${i}`, q]));
      return post<RawBatch>(reconcileRequestUrl(url), 'queries', batch, lang);
    },
    extend(ids, properties, lang) {
      return post<RawExtend>(
        `${config.API_BASE}/extend`,
        'extend',
        { ids, properties: properties.map((id) => ({ id })) },
        lang,
      );
    },
  };
}
