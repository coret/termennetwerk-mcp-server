import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { flattenExtend } from '../reconcileFlatten.js';
import { EXTEND_PROPERTIES } from '../upstream/reconcile.js';
import { cacheKey, withCache } from '../cache.js';
import { config } from '../config.js';
import { READ_ONLY, catalogLanguageSchema, looseOutput, ok, run, type Deps } from './common.js';

export function register(server: McpServer, deps: Deps): void {
  server.registerTool(
    'extend_terms',
    {
      title: 'Fetch term properties',
      description: `Fetch selected properties for known term URIs (W3C Reconciliation data extension), e.g. after reconcile: prefLabels, altLabels, scopeNotes, broaderTerms, exactMatches, birthDates, deathDates, occupations, placeNames, latitudes, longitudes, countries. Returns per URI a map property -> values (strings, or {id,name} for linked entities). URIs the service does not know are listed in notFound. Up to ${config.LIMITS.EXTEND_MAX} URIs per call.`,
      inputSchema: {
        ids: z.array(z.string().url()).min(1).max(config.LIMITS.EXTEND_MAX).describe('Term URIs.'),
        properties: z.array(z.enum(EXTEND_PROPERTIES)).min(1).describe('Properties to fetch.'),
        language: catalogLanguageSchema,
      },
      outputSchema: { rows: z.record(z.string(), z.any()), notFound: z.array(z.string()), ...looseOutput },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(deps, 'extend_terms', args.ids.length, async () => {
        const ids = [...new Set(args.ids)];
        const properties = [...new Set(args.properties)];
        const key = cacheKey('extend_terms', { ...args, ids, properties });
        const { value, hit } = await withCache(deps.cache, key, config.TTL.extend, async () => {
          const raw = await deps.recon.extend(ids, properties, args.language);
          return { value: flattenExtend(raw, ids), cacheable: true };
        });
        return { result: ok(value, (p) => [p.notFound]), hit };
      }),
  );
}
