import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './config.js';
import type { Deps } from './tools/common.js';
import { register as listSources } from './tools/listSources.js';
import { register as searchTerms } from './tools/searchTerms.js';
import { register as lookupTerms } from './tools/lookupTerms.js';
import { register as reconcile } from './tools/reconcile.js';
import { register as extendTerms } from './tools/extendTerms.js';

export type { Deps } from './tools/common.js';

export const INSTRUCTIONS =
  'Search, resolve and reconcile Dutch (and international) cultural heritage terminology via the NDE Network of Terms (Termennetwerk). Typical flow: list_sources to choose sources, search_terms to find term URIs from text, lookup_terms to get details for URIs you have, reconcile to match names (with person properties such as birth dates) to one source, and extend_terms to fetch properties for matched URIs. Always cite term URIs; they are persistent identifiers.';

export function createMcpServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: 'termennetwerk-mcp-server', title: 'NDE Network of Terms', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const register of [listSources, searchTerms, lookupTerms, reconcile, extendTerms]) {
    register(server, deps);
  }
  return server;
}
