import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { summarizeSources, type SourceSummary } from '../sources.js';
import { cacheKey, withCache } from '../cache.js';
import { config } from '../config.js';
import type { CatalogLang } from '../upstream/graphql.js';
import { READ_ONLY, catalogLanguageSchema, looseOutput, ok, run, type Deps } from './common.js';

// In-process fallback so a missing Redis does not add an upstream call to every tool call.
// Scoped per Deps instance so separate servers (and tests) do not share it.
const memos = new WeakMap<Deps, Map<string, { at: number; value: SourceSummary[] }>>();

export async function getSources(
  deps: Deps,
  lang: CatalogLang,
  genres?: string[],
): Promise<{ value: SourceSummary[]; hit: boolean }> {
  const key = cacheKey('sources', { lang, genres });
  let memo = memos.get(deps);
  if (!memo) memos.set(deps, (memo = new Map()));
  const local = memo.get(key);
  if (local && Date.now() - local.at < config.TTL.sources * 1000) return { value: local.value, hit: true };
  const res = await withCache(deps.cache, key, config.TTL.sources, async () => ({
    value: summarizeSources(await deps.gql.sources(lang, genres)),
    cacheable: true,
  }));
  memo.set(key, { at: Date.now(), value: res.value });
  return res;
}

export function register(server: McpServer, deps: Deps): void {
  server.registerTool(
    'list_sources',
    {
      title: 'List terminology sources',
      description:
        'List the terminology sources (thesauri, name authorities, gazetteers) in the NDE Network of Terms, e.g. AAT, Cultuurhistorische Thesaurus (CHT), RKDartists, GTAA, NTA, GeoNames, Wikidata, Iconclass. Call this first to choose sources for search_terms or reconcile; both accept a source URI or its exact name. Each source lists its genres, languages, availability and, when it has one, its reconciliationUrl (Wikidata sources have none).',
      inputSchema: {
        genres: z
          .array(z.string())
          .optional()
          .describe('Only sources in these genre URIs (see the genres of each source).'),
        language: catalogLanguageSchema,
      },
      outputSchema: { count: z.number(), sources: z.array(z.any()), ...looseOutput },
      annotations: READ_ONLY,
    },
    async ({ genres, language }) =>
      run(deps, 'list_sources', genres?.length ?? 0, async () => {
        const { value, hit } = await getSources(deps, language, genres);
        return { result: ok({ count: value.length, sources: value }, (p) => [p.sources]), hit };
      }),
  );
}

/**
 * Catalog for resolving source names: Dutch and English entries together, so a name
 * copied from list_sources in either language resolves. Duplicate URIs are fine:
 * resolution returns the first match and dedupes by URI.
 */
export async function getCatalog(deps: Deps): Promise<SourceSummary[]> {
  const [nl, en] = await Promise.all([getSources(deps, 'nl'), getSources(deps, 'en')]);
  return [...nl.value, ...en.value];
}
