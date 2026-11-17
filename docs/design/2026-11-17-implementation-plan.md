# Termennetwerk MCP Server Implementation Plan

**Goal:** A public, stateless MCP server at `https://mcp-termennetwerk.coret.org/` exposing five read-only tools over the NDE Network of Terms (GraphQL + Reconciliation API).

**Architecture:** Express app with the MCP SDK's `StreamableHTTPServerTransport` in stateless JSON mode (new `McpServer` per request). An upstream layer (typed GraphQL via graphql-request + codegen, fetch for reconciliation) feeds pure flattening functions that turn GraphQL unions and W3C reconciliation responses into compact JSON. Redis caches upstream answers; without Redis the server runs uncached.

**Tech Stack:** Node 24, TypeScript, `@modelcontextprotocol/sdk` 1.32, `express` 5, `express-rate-limit` 8, `zod` 4, `graphql` **16** (graphql-request 7 peers `graphql` 14-16), `graphql-request` 7, `@graphql-codegen/cli` 8 + `client-preset` 7, `ioredis` 6, `pino` 10, `tsx` (tests/dev), `node:test`.

**Spec:** `docs/design/2026-11-17-design.md`

## Global Constraints

- All code, comments, README, tool descriptions and commit messages in English. No em dashes in any text.
- Upstream base: `https://termennetwerk-api.netwerkdigitaalerfgoed.nl` (`/graphql`, reconciliation URLs from `features[type=RECONCILIATION].url`, `/extend`). Build and record fixtures against the **live** API, never the local `network-of-terms` checkout.
- Outgoing header `User-Agent: termennetwerk-mcp-server/<package version> (+https://github.com/coret/termennetwerk-mcp-server)`.
- Limits: `MAX_SOURCES = 10` per search; search `limit` default 20, max 100; `timeoutMs` max 60000; lookup ≤ 200 URIs; reconcile ≤ 10 queries; extend ≤ 100 ids; response byte budget 60 000 bytes (JSON text) with a truncation note.
- Never pass the tool's `limit` upstream to `terms`: always use upstream default (100), re-rank, then cut.
- Languages: GraphQL `nl | en | fy`; reconcile/extend/list_sources `nl | en` via `Accept-Language`.
- Redis default `redis://localhost:6379/9`, key prefix `tn:`; TTL seconds: sources 3600, search 3600, lookup 86400, reconcile 3600, extend 86400. Never cache a result that contains any error.
- Incoming rate limit: 60 `tools/call` requests per minute per IP (`app.set('trust proxy', 1)`); other JSON-RPC methods are not counted.
- Logging (pino): tool name, counts, duration ms, cache hit, error class. Never query text, URIs or IPs.
- Port 3004. Production runs `node dist/server.js`.
- Everything read-only: every tool has `annotations: { readOnlyHint: true, openWorldHint: true }`.

## Review Focus

1. **Upstream partially fails** (one source times out, others answer; GraphQL `errors` next to `data`): the tool returns the successful sources and marks the failed one `ok: false` with its message; nothing is cached. Test in Task 3 (`flattenTermsResults` with a `TimeoutError` entry) and Task 6 (search with error not cached).
2. **Source given by name, with different casing, or unknown**: `"rkdartists"` resolves to RKDartists; `"RKD"` gives an error listing close matches, not an empty result. Test in Task 2.
3. **Label fields empty or missing** (fy-only request, RKD `name: ""` with `en`, `alternateName: null`): output drops empty fields, reconcile falls back to `description`, nothing throws. Tests in Tasks 3 and 4.
4. **Huge answers** (100 terms × 10 sources, lookup of 200 URIs): response stays ≤ 60 000 bytes with `truncated: true` and a note telling the model how to narrow down. Test in Task 3 (`fitBudget`).
5. **Source URI containing `#`** (e.g. `http://vocab.getty.edu/aat#materials`) used for reconcile: request goes to the exact `features.url`, fragment percent-encoded so it reaches the server. Test in Task 4.

---

## File Structure

```
package.json  tsconfig.json  codegen.ts  .gitignore  LICENSE  README.md  server.json  start.sh
src/config.ts                 env + constants (Global Constraints values live here only)
src/log.ts                    pino logger
src/upstream/operations.graphql   Sources, Terms, Lookup queries
src/generated/               codegen output (committed)
src/upstream/graphql.ts       typed GraphQL client
src/upstream/reconcile.ts     reconcile + extend HTTP client
src/sources.ts                source summaries + name→URI resolution
src/flatten.ts                term/union flattening, ranking, byte budget
src/reconcileFlatten.ts       reconcile/extend flattening
src/cache.ts                  Redis cache + key normalisation
src/tools/*.ts                one file per tool: zod input schema + handler
src/mcp.ts                    createMcpServer(deps)
src/app.ts                    createApp(deps): express, origin, rate limit, routes
src/server.ts                 entrypoint: build deps, listen
well-known/mcp-server-card.json   public/index.html
scripts/record-fixtures.ts    records live responses to tests/fixtures/
tests/*.test.ts  tests/fixtures/*.json
```

---

### Task 1: Scaffold, config and typed GraphQL client

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `codegen.ts`, `src/config.ts`, `src/log.ts`, `src/upstream/operations.graphql`, `src/upstream/graphql.ts`, `src/upstream/limiter.ts`, `src/generated/*` (generated), `scripts/record-fixtures.ts`, `tests/fixtures/*.json`
- Test: `tests/graphql.test.ts`

**Interfaces:**
- Produces: `config` object (`PORT`, `REDIS_URL`, `API_BASE`, `USER_AGENT`, `LIMITS`, `TTL`, `ALLOWED_ORIGINS`, `RATE_LIMIT_PER_MIN`); `log`; `createGraphqlClient(opts?: { fetch?: typeof fetch; endpoint?: string }): GraphqlClient` with
  `sources(language: 'nl'|'en', genres?: string[]): Promise<SourcesQuery['sources']>`,
  `terms(args: { sources: string[]; query: string; languages?: Lang[]; genres?: string[]; queryMode?: 'OPTIMIZED'|'RAW'; timeoutMs?: number }): Promise<{ data: TermsQuery['terms']; errors: string[] }>`,
  `lookup(args: { uris: string[]; languages?: Lang[]; timeoutMs?: number }): Promise<{ data: LookupQuery['lookup']; errors: string[] }>`.
  `type Lang = 'nl'|'en'|'fy'`.
  `upstreamLimiter: { acquire(): Promise<void> }` in `limiter.ts`: the OA `RateLimiter` (`server.ts` of the Open Archives MCP server) at `config.UPSTREAM_RPS = 10`; every upstream call (GraphQL and reconcile) awaits `acquire()` first.

- [ ] **Step 1:** `package.json` (`"type": "module"`, `"name": "termennetwerk-mcp-server"`, version `0.1.0`, `license: "EUPL-1.2"`, `mcpName: "io.github.coret/termennetwerk-mcp-server"`, engines node ≥ 22; scripts `build: tsc`, `start: node dist/server.js`, `dev: tsx src/server.ts`, `test: node --import tsx --test tests/*.test.ts`, `codegen: graphql-codegen`, `record: tsx scripts/record-fixtures.ts`), install deps from Tech Stack, `tsconfig.json` (NodeNext, strict, outDir `dist`, rootDir `src`), `.gitignore` (`node_modules`, `dist`, `.env`).
- [ ] **Step 2:** `operations.graphql` with `Sources($genres)`, `Terms($sources,$query,$genres,$languages,$queryMode,$timeoutMs)` and `Lookup($uris,$languages,$timeoutMs)`, selecting every Term/TranslatedTerm field the spec's output lists (uri, prefLabel, altLabel, hiddenLabel, definition, scopeNote, seeAlso, broader/narrower/related/exactMatch {uri prefLabel}, place {name latitude longitude addressCountry}, person summary fields that exist in the live schema), `__typename`, and `... on Error { __typename message }`. `codegen.ts`: schema = live `/graphql` endpoint, documents = `src/upstream/*.graphql`, client-preset into `src/generated/`. Run `npm run codegen`; it must succeed.
- [ ] **Step 3: Failing test** `tests/graphql.test.ts`:
  `test('terms sends User-Agent and never sends limit')`: inject a fake `fetch` that captures the request; call `terms({ sources: ['x'], query: 'fiets' })`; assert header `user-agent` starts with `termennetwerk-mcp-server/`, body `variables` has no `limit`, response `{data:{terms:[]}}` yields `{ data: [], errors: [] }`.
  `test('partial GraphQL errors are returned, not thrown')`: fake response `{ data: { terms: [ ...one Terms result ] }, errors: [{ message: 'boom' }] }` → `errors` equals `['boom']` and `data` has 1 entry.
- [ ] **Step 4:** Run `npm test` → FAIL (module missing). Implement `graphql.ts` with graphql-request `GraphQLClient` using `errorPolicy: 'all'`, `Accept-Language` header per call for `sources`. Run → PASS.
- [ ] **Step 5:** `scripts/record-fixtures.ts`: records live JSON to `tests/fixtures/`: `sources.nl.json`; `terms.cht.fiets.json`; `terms.rkd.rembrandt.json`; `terms.aat.nl-en.json` (`languages:["nl","en"]`, query `"glas"`, AAT); `terms.timeout.json` (CHT + Wikidata all entities with `timeoutMs: 1`, to capture a `TimeoutError`; if both succeed, hand-edit one result into `{__typename:"TimeoutError", message:"..."}` and say so in a comment field `_note`); `lookup.mixed.json` (one CHT URI from the fiets fixture + `https://example.org/nope`); `reconcile.rkd.rembrandt.nl.json` and `.en.json` (`{"q0":{"query":"Rembrandt"}}`); `reconcile.rkd.person.json` (`{"q0":{"query":"Rembrandt","properties":[{"pid":"birthDates","v":"1606"}]}}`); `extend.json` (ids `[artists/66219, <CHT fiets uri>, https://example.org/nope]`, properties prefLabels, broaderTerms). Run `npm run record`; fixtures exist.
- [ ] **Step 6: Commit** `feat: scaffold project with typed GraphQL client and recorded fixtures` (include spec + this plan in the first commit if not yet committed: `docs: add design and implementation plan`).

### Task 2: Sources and name resolution

**Files:** Create `src/sources.ts`; Test `tests/sources.test.ts`

**Interfaces:**
- Consumes: `SourcesQuery['sources']` type (Task 1).
- Produces: `type SourceSummary = { uri; name; alternateName?; description?; inLanguage: string[]; genres: string[]; creators: string[]; reconciliationUrl?: string; supportsGenreFilter: boolean; available?: boolean; lastChecked?: string }`;
  `summarizeSources(raw): SourceSummary[]`;
  `resolveSource(input: string, sources: SourceSummary[]): SourceSummary` throws `UnknownSourceError` (`message` lists up to 5 suggestions, `suggestions: {uri,name}[]`);
  `resolveSources(inputs: string[], sources): SourceSummary[]` (dedupes by uri).

- [ ] **Step 1: Failing tests** on `sources.nl.json`: 58 summaries; RKDartists has `reconciliationUrl` and `supportsGenreFilter === false`; AAT has `supportsGenreFilter === true`; no summary has a `null` value (empty optional fields omitted); `resolveSource('https://data.rkd.nl/rkdartists')` and `resolveSource('rkdartists')` both return RKDartists; `resolveSource('RKD')` throws `UnknownSourceError` whose `suggestions` include RKDartists; `resolveSources(['RKDartists','https://data.rkd.nl/rkdartists'])` has length 1.
- [ ] **Step 2:** Run → FAIL. Implement: match order exact URI, case-insensitive exact name/alternateName; suggestions = sources whose name/alternateName/URI contains the input case-insensitively, then by shared tokens. Run → PASS.
- [ ] **Step 3: Commit** `feat: source summaries and name resolution`.

### Task 3: Term flattening, ranking and byte budget

**Files:** Create `src/flatten.ts`; Test `tests/flatten.test.ts`

**Interfaces:**
- Produces:
  `type Labels = string[] | Record<string, string[]>` (array for plain terms, language map for translated);
  `type CompactTerm = { uri; prefLabel?: Labels; altLabel?; hiddenLabel?; definition?; scopeNote?; seeAlso?: string[]; broader?: {uri; label?: Labels}[]; narrower?; related?; exactMatch?; place?: {...}; person?: {...} }` (empty fields omitted);
  `flattenTerm(raw): CompactTerm`;
  `rankTerms(terms: CompactTerm[], query: string): CompactTerm[]`;
  `type SourceResult = { source: {uri; name}; ok: boolean; error?: string; responseTimeMs?: number; total: number; terms: CompactTerm[] }`;
  `flattenTermsResults(raw: TermsQuery['terms'], query: string, limit: number): SourceResult[]`;
  `type LookupItem = { uri; ok: boolean; source?: {uri; name}; error?: string; term?: CompactTerm }`;
  `flattenLookup(raw: LookupQuery['lookup']): LookupItem[]`;
  `fitBudget<T extends object>(payload: T, listPath: (p: T) => unknown[][], maxBytes: number): T & { truncated?: true; note?: string }`;
  `hasErrors(results: { ok: boolean }[]): boolean`.

- [ ] **Step 1: Failing tests**
  - `flattenTermsResults(rkdFixture, 'Rembrandt', 3)[0].terms.map(t=>t.uri)` contains `https://data.rkd.nl/artists/66219` at index 0; `total === 19` (the count before cutting; use the fixture's actual count).
  - CHT fiets: every term has `uri`, no key with value `[]`, `null` or `''`.
  - AAT nl-en fixture: `prefLabel` is an object with key `nl` (and `en` where present), never `[{language,value}]`.
  - Timeout fixture: the failed source has `ok: false`, `error` non-empty, `terms: []`; the other has `ok: true`; `hasErrors(...) === true`.
  - Lookup mixed: the CHT item `ok: true` with `term.prefLabel`; the example.org item `ok: false` with `error` and no `term`.
  - `fitBudget` with 10 sources × 100 synthetic terms of ~500 bytes: `JSON.stringify(result).length <= 60000`, `truncated === true`, `note` mentions narrowing the query or lowering `limit`; small payload is returned unchanged without `truncated`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Ranking algorithm (stable sort on rank, upstream order as tie-break), comparing on `normalize(s) = s.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').trim()` and all prefLabel values (any language):
  rank 0 prefLabel equals query; 1 prefLabel starts with query; 2 altLabel equals query; 3 any prefLabel/altLabel contains query; 4 rest.
  `fitBudget`: while over budget, drop the last term of the longest list; stop when within budget.
- [ ] **Step 4:** Run → PASS. **Commit** `feat: flatten GraphQL term results with ranking and byte budget`.

### Task 4: Reconciliation and data extension

**Files:** Create `src/upstream/reconcile.ts`, `src/reconcileFlatten.ts`; Test `tests/reconcile.test.ts`

**Interfaces:**
- Produces:
  `RECONCILE_PIDS` (13 pids from the spec) and `EXTEND_PROPERTIES` (26 ids from `/extend/propose`) as `const` tuples;
  `type ReconcileQuery = { query: string; type?: string; limit?: number; properties?: { pid: typeof RECONCILE_PIDS[number]; v: string }[] }`;
  `createReconcileClient(opts?: { fetch?: typeof fetch }): { reconcile(url: string, queries: ReconcileQuery[], lang: 'nl'|'en'): Promise<RawBatch>; extend(ids: string[], properties: string[], lang): Promise<RawExtend> }`;
  `reconcileRequestUrl(featureUrl: string): string`;
  `type Candidate = { id; name; score: number; match: boolean; type: string[]; description?: string; features?: {id; value}[] }`;
  `flattenReconcile(raw: RawBatch, queries: ReconcileQuery[]): { query: string; candidates: Candidate[] }[]`;
  `flattenExtend(raw: RawExtend, ids: string[]): { rows: Record<string, Record<string, (string | {id: string; name?: string})[]>>; notFound: string[] }`.

- [ ] **Step 1: Failing tests**
  - `reconcileRequestUrl('https://termennetwerk-api.netwerkdigitaalerfgoed.nl/reconcile/http://vocab.getty.edu/aat#materials')` keeps the path and percent-encodes `#` as `%23` (no fragment in the resulting `URL`).
  - Client: fake fetch captures a POST with form field `queries` = `{"q0":{...},"q1":{...}}` (object keyed `q0..`), header `accept-language: en`.
  - `flattenReconcile(nlFixture, [{query:'Rembrandt'}])[0].candidates[0]` = id `https://data.rkd.nl/artists/66219`, score 100, `match: true`, `type` includes `https://schema.org/Person`.
  - En fixture: no candidate has `name === ''` (falls back to `description`).
  - `match` is true only for score 100 or a single candidate; otherwise false.
  - Person fixture: candidate has `features` when upstream returned them.
  - `flattenExtend(extendFixture, ids)`: 66219 has `prefLabels`; `notFound` equals `['https://example.org/nope']`.
- [ ] **Step 2:** Run → FAIL. Implement (form-encoded POST like the docs' curl, `Accept-Language`, `User-Agent`, 120 s abort timeout). Run → PASS.
- [ ] **Step 3: Commit** `feat: reconciliation and data extension client`.

### Task 5: Redis cache

**Files:** Create `src/cache.ts`; Test `tests/cache.test.ts`

**Interfaces:**
- Produces: `cacheKey(tool: string, args: unknown): string` (`tn:<tool>:<sha1 of canonical JSON>`; canonical = keys sorted recursively, arrays of strings sorted for `sources`, `languages`, `genres`, `uris`, `ids`, `properties`; `queries` order kept);
  `createCache(url: string | null, log): Cache` with `get<T>(key): Promise<T | null>`, `set(key, value, ttlSeconds): Promise<void>`, `readonly available: boolean`, `close(): Promise<void>`;
  `withCache<T>(cache, key, ttl, produce: () => Promise<{ value: T; cacheable: boolean }>): Promise<{ value: T; hit: boolean }>`.

- [ ] **Step 1: Failing tests**: `cacheKey('search_terms', {sources:['b','a'], query:'x'}) === cacheKey('search_terms', {query:'x', sources:['a','b']})`; different query → different key; `createCache('redis://127.0.0.1:1/9', log)`: `available === false`, `get` resolves `null`, `set` resolves without throwing; `withCache` with a fake in-memory `Cache` calls `produce` once for two calls when `cacheable: true` and twice when `cacheable: false`.
- [ ] **Step 2:** Run → FAIL. Implement with ioredis `lazyConnect`, `enableOfflineQueue: false`, degraded mode as in `server.ts` of the Open Archives MCP server. Run → PASS.
- [ ] **Step 3: Commit** `feat: Redis cache with degraded mode`.

### Task 6: The five tools and the MCP server

**Files:** Create `src/tools/listSources.ts`, `searchTerms.ts`, `lookupTerms.ts`, `reconcile.ts`, `extendTerms.ts`, `src/mcp.ts`; Test `tests/mcp.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: `type Deps = { gql: GraphqlClient; recon: ReconcileClient; cache: Cache; log: Logger }`; `createMcpServer(deps: Deps): McpServer` (name `termennetwerk-mcp-server`, version from package.json, `instructions` string). Each tool file exports `register(server: McpServer, deps: Deps): void`. Source list for resolution comes from `getSources(deps, lang)` (cached, TTL 3600) in `src/tools/listSources.ts`.
- Tool contract: input schemas exactly as the spec table (zod, with `.describe()` texts); success returns `{ content: [{type:'text', text: JSON}], structuredContent }` after `fitBudget`; errors (unknown source, source without reconciliation, upstream HTTP failure) return `isError: true` with a message that tells the model what to do next (e.g. "call list_sources").
- Descriptions must say: use `list_sources` first; search vs lookup; Wikidata sources have no reconciliation (use `search_terms`); upstream may fail per source; `fy` labels are sparse.

- [ ] **Step 1: Failing tests** using SDK `InMemoryTransport.createLinkedPair()` + `Client`, with stub `gql`/`recon` returning fixtures and an in-memory `Cache`:
  - `tools/list` returns exactly `list_sources, search_terms, lookup_terms, reconcile, extend_terms`, all `readOnlyHint: true`.
  - `search_terms` with 11 sources → error result (validation), stub `gql.terms` not called.
  - `search_terms {sources:['RKDartists'], query:'Rembrandt', limit:3}` → first term uri `.../artists/66219`; stub received the resolved URI and no `limit`.
  - `search_terms` against the timeout fixture twice → stub called twice (error results not cached); against CHT fiets twice → once.
  - `reconcile {source:'Wikidata: alle entiteiten', ...}` → `isError` with text mentioning `search_terms`.
  - `reconcile {source:'RKDartists', queries:[{query:'Rembrandt'}]}` → `structuredContent` first candidate `match: true`.
  - `extend_terms` → `notFound` contains `https://example.org/nope`.
- [ ] **Step 2:** Run → FAIL. Implement; each handler logs one line `{ tool, count, ms, hit, error? }` (count = sources/uris/queries/ids). Run → PASS.
- [ ] **Step 3: Commit** `feat: register the five Network of Terms tools`.

### Task 7: HTTP app: transport, origin check, rate limit, health, landing

**Files:** Create `src/app.ts`, `src/server.ts`, `public/index.html`, `well-known/mcp-server-card.json`; Test `tests/app.test.ts`

**Interfaces:**
- Consumes: `createMcpServer(deps)`, `config`.
- Produces: `createApp(deps: Deps, opts?: { rateLimitPerMin?: number }): express.Express`. Routes: `POST /` and `POST /mcp` (origin check → rate limit → stateless `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`, server+transport closed on `res.close`); `GET /` and `GET /mcp` with `Accept: text/event-stream` → 405, otherwise `public/index.html`; `GET /health` → `{ status: 'ok', redis: boolean, version }`; `/.well-known/mcp/server-card.json` and `/.well-known/mcp.json` → server card. Origin rule copied from OA `isOriginAllowed` (`server.ts` of the Open Archives MCP server): no Origin allowed; `https://claude.ai`, `https://claude.com` and `*.claude.ai`/`*.claude.com` suffixes allowed; extras via `ALLOWED_ORIGINS`.

- [ ] **Step 1: Failing tests** (start `createApp(stubDeps, { rateLimitPerMin: 3 }).listen(0)`, use `fetch`):
  - `GET /health` → 200, `status === 'ok'`.
  - `POST /mcp` with `Origin: https://evil.example` → 403.
  - `POST /mcp` `initialize` then `tools/list` (headers `Accept: application/json, text/event-stream`) → JSON with 5 tools.
  - 4 × `tools/call` within the window → 4th is 429; 4 × `tools/list` → none 429.
  - `GET /` with `Accept: text/event-stream` → 405; plain `GET /` → HTML containing `mcp-termennetwerk.coret.org`.
- [ ] **Step 2:** Run → FAIL. Implement (`app.set('trust proxy', 1)`; `express.json({ limit: '256kb' })` before the limiter; limiter `skip: req => req.body?.method !== 'tools/call'`, 429 body is a JSON-RPC error with message "Rate limit exceeded: max 60 tool calls per minute"). `server.ts` builds real deps from `config` and listens on `PORT`. Run → PASS.
- [ ] **Step 3:** `npm run build` and `npx tsc --noEmit` clean; `npm start`, then `curl -s localhost:3004/health` → `{"status":"ok",...}`.
- [ ] **Step 4: Commit** `feat: stateless HTTP transport with origin check and rate limiting`.

### Task 8: Documentation, registry metadata and deployment

**Files:** Create `README.md`, `LICENSE` (EUPL-1.2 text, copy from the upstream `network-of-terms` repository), `server.json`, `start.sh`; system: Apache vhost and process supervisor configuration.

- [ ] **Step 1:** README (English), conformance-report style: what it is; connect via claude.ai custom connector (`https://mcp-termennetwerk.coret.org/`) and Claude Code (`claude mcp add --transport http termennetwerk https://mcp-termennetwerk.coret.org/`); tool table; **mapping table** tool → upstream operation/arguments; design decisions (limit re-ranking, name resolution, byte budget, caching, rate limits, privacy of logs); observations on the upstream API (the builder-check facts from the spec); local development (`npm run dev`, `npm test`, `npm run codegen`, `npm run record`); validation recipe (the Verification list below); what does NOT work yet; `- [ ]` roadmap (stdio transport, MCP registry publication, Dutch README translation, `/suggest/property` use, preview links).
- [ ] **Step 2:** `server.json` (schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`, remote `streamable-http` `https://mcp-termennetwerk.coret.org/`) and server card, modelled on `server.json` of the Open Archives MCP server and `well-known/mcp-server-card.json`.
- [ ] **Step 3:** `start.sh` (cd repo, `NODE_ENV=production PORT=3004 REDIS_URL=redis://localhost:6379/9`, `exec node dist/server.js`), executable.
- [ ] **Step 4:** Apache vhost `mcp-termennetwerk.coret.org` (wildcard certificate, `ProxyPreserveHost On`, `ProxyRequests Off`, `ProxyTimeout 180`, `ProxyPass / http://127.0.0.1:3004/`, own logs); configtest → `Syntax OK`; reload Apache.
- [ ] **Step 5:** Process supervisor program `termennetwerk-mcp` running `start.sh` as the web user, own log file; status → RUNNING.
- [ ] **Step 6:** Verification (all must pass):
  - `curl -s https://mcp-termennetwerk.coret.org/health` → `status: ok`, `redis: true`.
  - MCP Inspector (`npx @modelcontextprotocol/inspector`, URL `https://mcp-termennetwerk.coret.org/`): each tool once with the spec's examples (CHT "fiets"; AAT `languages:["nl","en"]`; lookup CHT URI + unknown; reconcile RKDartists "Rembrandt" → 66219 score 100; person query with `birthDates`; extend prefLabels+broaderTerms; search RKD "Rembrandt" `limit:3` contains 66219).
  - Same search twice → second logged as cache hit; `redis-cli -n 9 --scan --pattern 'tn:*'` non-empty.
  - 61 `tools/call` in a minute → 429.
- [ ] **Step 7: Commit** `docs: README, registry metadata and deployment files`. Ask the maintainer before creating the GitHub repo, pushing, or publishing to the MCP registry.
