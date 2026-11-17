import type { SourcesData } from './upstream/graphql.js';

export interface SourceSummary {
  uri: string;
  name: string;
  alternateName?: string;
  description?: string;
  inLanguage: string[];
  genres: string[];
  creators: string[];
  website?: string;
  reconciliationUrl?: string;
  supportsGenreFilter: boolean;
  available?: boolean;
  lastChecked?: string;
}

export class UnknownSourceError extends Error {
  constructor(
    public readonly input: string,
    public readonly suggestions: { uri: string; name: string }[],
  ) {
    const hint = suggestions.length
      ? ` Did you mean: ${suggestions.map((s) => `"${s.name}" (${s.uri})`).join(', ')}?`
      : '';
    super(`Unknown source "${input}". Call list_sources for valid source URIs and names.${hint}`);
    this.name = 'UnknownSourceError';
  }
}

export function summarizeSources(raw: SourcesData): SourceSummary[] {
  return raw
    .filter((s): s is NonNullable<typeof s> => s != null)
    .map((s) => {
      const summary: SourceSummary = {
        uri: s.uri,
        name: s.name,
        inLanguage: s.inLanguage.flatMap((l) => (l ? [String(l)] : [])),
        genres: s.genres.flatMap((g) => (g ? [g.name] : [])),
        creators: s.creators.flatMap((c) => (c ? [c.name] : [])),
        supportsGenreFilter: s.features.some((f) => f?.type === 'GENRE_FILTER'),
      };
      if (s.alternateName) summary.alternateName = s.alternateName;
      if (s.description) summary.description = s.description;
      const website = s.mainEntityOfPage.find((u): u is string => !!u);
      if (website) summary.website = website;
      const recon = s.features.find((f) => f?.type === 'RECONCILIATION')?.url;
      if (recon) summary.reconciliationUrl = recon;
      if (s.status) {
        summary.available = s.status.isAvailable;
        summary.lastChecked = s.status.lastChecked;
      }
      return summary;
    });
}

const norm = (s: string) => s.trim().toLowerCase();

export function resolveSource(input: string, sources: SourceSummary[]): SourceSummary {
  const exact = sources.find((s) => s.uri === input.trim());
  if (exact) return exact;
  const q = norm(input);
  const byName = sources.find(
    (s) => norm(s.name) === q || (s.alternateName !== undefined && norm(s.alternateName) === q),
  );
  if (byName) return byName;
  throw new UnknownSourceError(input, suggest(q, sources));
}

export function resolveSources(inputs: string[], sources: SourceSummary[]): SourceSummary[] {
  const seen = new Map<string, SourceSummary>();
  for (const input of inputs) {
    const s = resolveSource(input, sources);
    seen.set(s.uri, s);
  }
  return [...seen.values()];
}

function suggest(q: string, sources: SourceSummary[]): { uri: string; name: string }[] {
  const tokens = q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
  const scored = sources
    .map((s) => {
      const hay = norm(`${s.name} ${s.alternateName ?? ''} ${s.uri}`);
      let score = hay.includes(q) ? 10 : 0;
      for (const t of tokens) if (hay.includes(t)) score += 1;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const unique = new Map<string, { uri: string; name: string }>();
  for (const { s } of scored) if (!unique.has(s.uri)) unique.set(s.uri, { uri: s.uri, name: s.name });
  return [...unique.values()].slice(0, 5);
}
