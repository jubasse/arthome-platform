# Search, the date page and link resolution, from the storefront BFF

`GET /v1/search` crosses three processes: `bff-storefront` (on `PORT`, `CATALOG_URL` pointing at
catalog, `http://localhost:3002` by default), catalog's API, which reads `arthome-catalog-date` at
`OPENSEARCH_URL`, and `search-indexer`, which writes it. Nobody calls the indexer.

```bash
cd apps/bff-storefront && PORT=3003 node dist/main.js
curl 'localhost:3003/v1/search?q=nuit&sort=soon' -H 'X-Arthome-Surface: storefront_tv'
```

The handler is bound to `storefrontApi.routes.search` from `@arthome/contracts/storefront-api` with
`@Endpoint` (`libs/http-edge/src/endpoint.ts`): the path, the status, the query and the
`X-Arthome-Surface` header are validated against the contract, and the compiler checks the answer
against the route's 200 body.

The BFF gives catalog a deadline 200 ms out (`x-arthome-deadline`, transport.md §5.9), creates the
`traceparent` when the surface sent none, relays only the codes the route declares, and turns every
other failure into `api.upstream_unavailable` (502) or `api.upstream_timeout` (504). Catalog refuses
a call without a deadline. What catalog serves and refuses is in `apps/catalog/HANDOVER.md` §0.

Proven on the running stack on 2026-09-26, with a show published on two dates through the studio
commands, the indexer, catalog and the BFF running:

| Check | Result |
| --- | --- |
| the index's `-v1` at the indexer's start | `slug_fr`, `slug_en`, `ends_at`, `over_at` added in place, no reindex |
| the index's `-v1` at the indexer's start (RS1) | `replay_state`, `replay_closes_at`, `replay_online_at`, `replay_duration_sec` added in place, no reindex; `over_at` is the replay's real closing |
| `q=nuit&sort=soon` | one group, `Nuits blanches`, `matchingDatesCount` 2, the 12 December date first, `scheduled` until the room opens, the envelope's `validUntil` that instant; facets counted in shows; `public, max-age=60` and the `Vary` list |
| latency through the BFF | 184 ms on the first call, cold; 18 to 38 ms over the next ten |
| `countryCodes=BE` | no group, `emptyReason: no_match_with_filters` |
| `priceMaxMinor` and `tab=artists` | catalog's 400 relayed, both fields named, the caller's `traceId` |
| `tab=concerts`, a studio surface | refused by the BFF, 400, before catalog is called |
| catalog without a deadline, or a past one | 400 naming `x-arthome-deadline`; 504 `api.deadline_exceeded` |
| OpenSearch paused | 504 `api.upstream_timeout` in 203 ms, and 200 again once it resumes |
| catalog stopped | 502 `api.upstream_unavailable` in 3 ms; the refused connection logged by the BFF |

The BFF also serves `GET /v1/dates/:dateId` (public, `max-age=60`, an `ETag` answered 304) and
`GET /v1/resolve` (public, `max-age=300`), from catalog's `date_detail_public` rather than the
index; `apps/catalog/HANDOVER.md` §0b says what they serve. Proven on the running stack on
2026-09-27, the migration applied to the stack above:

| Check | Result |
| --- | --- |
| the migration | `date_detail_public` created and filled with the two dates already published |
| the page through the BFF | 200 in 61 ms cold, 8 to 9 ms after; the venue's name, the synopsis, the other date in `seriesDates`, `validUntil` the room opening |
| the same request with its `ETag` | 304, no body |
| a French URL, the English one, `kind=date&slug=` | the same date, and its current canonical URL |
| an unknown slug; `kind=artist` | 404 `api.not_found`; 400 naming `kind` |
| the show retitled | the page carries the new title at once, and the old `ETag` no longer matches |
| a draft | 404 |

