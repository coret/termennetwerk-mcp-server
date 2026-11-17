import type {
  TermFieldsFragment,
  TranslatedTermFieldsFragment,
  PersonFieldsFragment,
  PlaceFieldsFragment,
  OrganizationFieldsFragment,
} from './generated/graphql.js';
import type { TermsData, LookupData } from './upstream/graphql.js';

/** Plain terms carry `string[]`; translated terms (when `languages` is given) a language map. */
export type Labels = string[] | Record<string, string[]>;

export interface Ref {
  uri?: string;
  name?: Labels;
}

export interface RelatedRef {
  uri: string;
  label?: Labels;
}

export interface CompactPlace {
  name?: Labels;
  latitude?: number;
  longitude?: number;
  addressCountry?: string;
}

export interface CompactPerson {
  givenName?: Labels;
  familyName?: Labels;
  birthDate?: string;
  deathDate?: string;
  birthPlace?: Ref[];
  deathPlace?: Ref[];
  occupations?: string[];
  nationality?: Ref[];
  gender?: Ref[];
  parent?: Ref[];
  children?: Ref[];
  spouse?: Ref[];
  sibling?: Ref[];
}

export interface CompactOrganization {
  type?: Ref[];
  foundingDate?: string;
  dissolutionDate?: string;
  location?: Ref[];
  parentOrganization?: Ref[];
}

export interface CompactTerm {
  uri: string;
  prefLabel?: Labels;
  altLabel?: Labels;
  hiddenLabel?: Labels;
  definition?: Labels;
  scopeNote?: Labels;
  seeAlso?: string[];
  broader?: RelatedRef[];
  narrower?: RelatedRef[];
  related?: RelatedRef[];
  exactMatch?: RelatedRef[];
  place?: CompactPlace;
  person?: CompactPerson;
  organization?: CompactOrganization;
}

export interface SourceResult {
  source: { uri: string; name: string };
  ok: boolean;
  error?: string;
  responseTimeMs?: number;
  total: number;
  terms: CompactTerm[];
}

export interface LookupItem {
  uri: string;
  ok: boolean;
  source?: { uri: string; name: string };
  error?: string;
  term?: CompactTerm;
}

type LangString = { language: string; value: string } | null;
type Mode = 'plain' | 'map';

// ── helpers ──────────────────────────────────────────────────────────────────

const isEmpty = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Removes undefined/null/''/[]/{} values (shallow; callers prune nested objects first). */
function prune<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) if (isEmpty(obj[key])) delete obj[key];
  return obj;
}

const strings = (xs: readonly (string | null | undefined)[] | null | undefined): string[] =>
  [...new Set((xs ?? []).filter((x): x is string => !!x && x.trim() !== ''))];

function langStrings(xs: readonly LangString[] | null | undefined, mode: Mode): Labels | undefined {
  const list = (xs ?? []).filter((x): x is NonNullable<LangString> => !!x && x.value.trim() !== '');
  if (list.length === 0) return undefined;
  if (mode === 'plain') return [...new Set(list.map((x) => x.value))];
  const map: Record<string, string[]> = {};
  for (const { language, value } of list) {
    const bucket = (map[language] ??= []);
    if (!bucket.includes(value)) bucket.push(value);
  }
  return map;
}

function refs(
  xs: readonly ({ uri?: string | null; name: readonly LangString[] } | null)[] | null | undefined,
  mode: Mode,
): Ref[] | undefined {
  const out = (xs ?? []).flatMap((x) => {
    if (!x) return [];
    const r = prune({ uri: x.uri ?? undefined, name: langStrings(x.name, mode) } as Ref);
    return isEmpty(r) ? [] : [r];
  });
  return out.length ? out : undefined;
}

function place(p: PlaceFieldsFragment | null | undefined, mode: Mode): CompactPlace | undefined {
  if (!p) return undefined;
  const out = prune<CompactPlace>({
    name: langStrings(p.name, mode),
    latitude: p.latitude ?? undefined,
    longitude: p.longitude ?? undefined,
    addressCountry: p.addressCountry ?? undefined,
  });
  return isEmpty(out) ? undefined : out;
}

function occupations(p: PersonFieldsFragment): string[] | undefined {
  const names = (p.hasOccupation ?? []).flatMap((o) => {
    if (!o) return [];
    const label =
      (o.roleName ?? []).find((x) => x?.value)?.value ??
      (o.occupation?.name ?? []).find((x) => x?.value)?.value;
    if (!label) return [];
    const span = [o.startDate, o.endDate].filter(Boolean).join('/');
    return [span ? `${label} (${span})` : label];
  });
  const unique = [...new Set(names)];
  return unique.length ? unique : undefined;
}

function person(p: PersonFieldsFragment | null | undefined, mode: Mode): CompactPerson | undefined {
  if (!p) return undefined;
  const out = prune<CompactPerson>({
    givenName: langStrings(p.givenName, mode),
    familyName: langStrings(p.familyName, mode),
    birthDate: p.birthDate ?? undefined,
    deathDate: p.deathDate ?? undefined,
    birthPlace: refs(p.birthPlace, mode),
    deathPlace: refs(p.deathPlace, mode),
    occupations: occupations(p),
    nationality: refs(p.nationality, mode),
    gender: refs(p.gender, mode),
    parent: refs(p.parent, mode),
    children: refs(p.children, mode),
    spouse: refs(p.spouse, mode),
    sibling: refs(p.sibling, mode),
  });
  return isEmpty(out) ? undefined : out;
}

function organization(
  o: OrganizationFieldsFragment | null | undefined,
  mode: Mode,
): CompactOrganization | undefined {
  if (!o) return undefined;
  const out = prune<CompactOrganization>({
    type: refs(o.additionalType, mode),
    foundingDate: o.foundingDate ?? undefined,
    dissolutionDate: o.dissolutionDate ?? undefined,
    location: refs(o.location, mode),
    parentOrganization: refs(o.parentOrganization, mode),
  });
  return isEmpty(out) ? undefined : out;
}

function related(
  xs: readonly ({ uri: string; prefLabel: readonly (string | null)[] } | null)[] | null | undefined,
): RelatedRef[] | undefined {
  const out = (xs ?? []).flatMap((x) => {
    if (!x) return [];
    const label = strings(x.prefLabel);
    return [label.length ? { uri: x.uri, label } : { uri: x.uri }];
  });
  return out.length ? out : undefined;
}

function relatedT(
  xs: readonly ({ uri: string; prefLabel: readonly LangString[] } | null)[] | null | undefined,
): RelatedRef[] | undefined {
  const out = (xs ?? []).flatMap((x) => {
    if (!x) return [];
    const label = langStrings(x.prefLabel, 'map');
    return [label ? { uri: x.uri, label } : { uri: x.uri }];
  });
  return out.length ? out : undefined;
}

const nonEmpty = (xs: string[]): string[] | undefined => (xs.length ? xs : undefined);

// ── terms ────────────────────────────────────────────────────────────────────

export function flattenTerm(raw: TermFieldsFragment | TranslatedTermFieldsFragment): CompactTerm {
  if ('prefLabelT' in raw) {
    return prune<CompactTerm>({
      uri: raw.uri,
      prefLabel: langStrings(raw.prefLabelT, 'map'),
      altLabel: langStrings(raw.altLabelT, 'map'),
      hiddenLabel: langStrings(raw.hiddenLabelT, 'map'),
      definition: langStrings(raw.definitionT, 'map'),
      scopeNote: langStrings(raw.scopeNoteT, 'map'),
      seeAlso: nonEmpty(strings(raw.seeAlso)),
      broader: relatedT(raw.broaderT),
      narrower: relatedT(raw.narrowerT),
      related: relatedT(raw.relatedT),
      exactMatch: relatedT(raw.exactMatchT),
      place: place(raw.place, 'map'),
      person: person(raw.person, 'map'),
      organization: organization(raw.organization, 'map'),
    });
  }
  return prune<CompactTerm>({
    uri: raw.uri,
    prefLabel: nonEmpty(strings(raw.prefLabel)),
    altLabel: nonEmpty(strings(raw.altLabel)),
    hiddenLabel: nonEmpty(strings(raw.hiddenLabel)),
    definition: nonEmpty(strings(raw.definition)),
    scopeNote: nonEmpty(strings(raw.scopeNote)),
    seeAlso: nonEmpty(strings(raw.seeAlso)),
    broader: related(raw.broader),
    narrower: related(raw.narrower),
    related: related(raw.related),
    exactMatch: related(raw.exactMatch),
    place: place(raw.place, 'plain'),
    person: person(raw.person, 'plain'),
    organization: organization(raw.organization, 'plain'),
  });
}

const normalize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();

const labelValues = (l: Labels | undefined): string[] =>
  !l ? [] : Array.isArray(l) ? l : Object.values(l).flat();

/**
 * Stable re-rank: 0 prefLabel equals query, 1 prefLabel starts with query,
 * 2 altLabel equals query, 3 any label contains query, 4 rest. Upstream order breaks ties.
 */
export function rankTerms(terms: CompactTerm[], query: string): CompactTerm[] {
  const q = normalize(query);
  const rank = (t: CompactTerm): number => {
    const pref = labelValues(t.prefLabel).map(normalize);
    const alt = labelValues(t.altLabel).map(normalize);
    if (pref.some((p) => p === q)) return 0;
    if (pref.some((p) => p.startsWith(q))) return 1;
    if (alt.some((a) => a === q)) return 2;
    if ([...pref, ...alt].some((x) => x.includes(q))) return 3;
    return 4;
  };
  return terms
    .map((t, i) => ({ t, i, r: rank(t) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ t }) => t);
}

export function flattenTermsResults(raw: TermsData, query: string, limit: number): SourceResult[] {
  return raw.flatMap((entry): SourceResult[] => {
    if (!entry) return [];
    const base = {
      source: { uri: entry.source.uri, name: entry.source.name },
      responseTimeMs: entry.responseTimeMs,
    };
    const result = entry.result;
    if ('message' in result) {
      return [{ ...base, ok: false, error: `${result.__typename}: ${result.message}`, total: 0, terms: [] }];
    }
    const rawTerms =
      result.__typename === 'Terms'
        ? (result.terms ?? [])
        : result.__typename === 'TranslatedTerms'
          ? (result.translatedTerms ?? [])
          : [];
    const terms = rankTerms(
      rawTerms.flatMap((t) => (t ? [flattenTerm(t)] : [])),
      query,
    );
    return [{ ...base, ok: true, total: terms.length, terms: terms.slice(0, limit) }];
  });
}

export function flattenLookup(raw: LookupData): LookupItem[] {
  return raw.flatMap((entry) => {
    if (!entry) return [];
    const item: LookupItem = { uri: entry.uri, ok: false };
    if (entry.source.__typename === 'Source') {
      item.source = { uri: entry.source.uri, name: entry.source.name };
    }
    const result = entry.result;
    if ('message' in result) {
      const sourceError = 'message' in entry.source ? `${entry.source.message}; ` : '';
      item.error = `${sourceError}${result.__typename}: ${result.message}`;
    } else if (result.__typename === 'Term' || result.__typename === 'TranslatedTerm') {
      item.ok = true;
      item.term = flattenTerm(result);
    }
    return [item];
  });
}

export const hasErrors = (results: readonly { ok: boolean }[]): boolean =>
  results.some((r) => !r.ok);

// ── byte budget ──────────────────────────────────────────────────────────────

export type Budgeted<T> = T & { truncated?: true; note?: string };

const TRUNCATION_NOTE =
  'Response truncated to stay within the size budget. Lower `limit`, query fewer sources or URIs, or narrow the query.';

/**
 * Drops trailing items from the longest list returned by `lists` until the JSON
 * serialization fits in `maxBytes`. The lists are mutated on a deep copy.
 */
export function fitBudget<T extends object>(
  payload: T,
  lists: (p: T) => unknown[][],
  maxBytes: number,
): Budgeted<T> {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (size(payload) <= maxBytes) return payload;
  const copy = structuredClone(payload) as Budgeted<T>;
  copy.truncated = true;
  copy.note = TRUNCATION_NOTE;
  const arrays = lists(copy);
  while (size(copy) > maxBytes) {
    const longest = arrays.reduce((a, b) => (b.length > a.length ? b : a), [] as unknown[]);
    if (longest.length === 0) break;
    // Remove in chunks to keep this fast on very large payloads.
    longest.splice(-Math.max(1, Math.ceil(longest.length / 20)));
  }
  return copy;
}
