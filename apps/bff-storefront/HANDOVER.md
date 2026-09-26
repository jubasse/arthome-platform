# `bff-storefront` — handover

The storefront's BFF (`context-map.md`: one BFF per product, owned by its surfaces). It serves
`openapi/storefront.yaml` from the services behind it and holds no domain rule. One route today,
`GET /v1/search`, from catalog. Written 2026-09-26.

## 1. What was built

| File | What it is |
| --- | --- |
| `src/search/search.controller.ts` | the route: surface check, deadline, the call, the public cache headers |
| `src/search/search-query.schema.ts` | the contract's query parameters, query-string values coerced |
| `src/search/search-response.schema.ts` | the 200 body, composed from `@arthome/contracts` |
| `src/catalog/catalog.client.ts` | the one adapter to catalog: deadline, trace, error mapping |
| `src/traceparent.middleware.ts` | a `traceparent` on every request that arrives without a valid one |

Proven by `src/catalog/catalog.client.spec.ts` (a stand-in catalog over HTTP),
`src/search/search.e2e.spec.ts` (the whole app through Fastify), and on the running stack
(`AGENTS.md`, "Search, from the storefront BFF to the index").

## 2. Decisions, and why

- **The deadline is 200 ms out**, transport.md §5.9's search budget, sent as `x-arthome-deadline`
  and armed locally with `AbortSignal.timeout` on the same instant. The surface hanging up aborts
  the call too.
- **Only `STOREFRONT_RELAYED_CODES` cross** (`@arthome/contracts/envelope`, where transport.md §5.5
  puts the allowlist), with their status and params. Catalog's `api.deadline_exceeded` becomes
  `api.upstream_timeout`; anything else, a 2xx outside the contract included, becomes
  `api.upstream_unavailable`, and the original is logged with the `traceparent`. No retry here:
  the surface is the one layer that retries.
- **A `traceparent` is created when the surface sent none or a broken one**, on the request itself:
  the error filter reads it there, and the storefront `Error` requires a `traceId`.
- **`Cache-Control: public, max-age=60`** and the contract's `Vary`: every call is anonymous today,
  no overlay is composed, so the body is the same for every caller. The day a session adds
  overlays, the header must turn `private` for that caller.
- **`DenyInProductionGuard` is bound**, as in the services: this BFF mints no service token, and
  the services refuse every request in production for the same reason.
- **Readiness checks nothing downstream**: a catalog outage fails searches, it must not take the
  BFF out of rotation.

## 3. Known gaps

- **The query schema is a hand copy of `storefront.yaml`'s parameters.** D-058 gives `paths` no zod
  source, so `check-emit-diff` does not compare them; only the criteria come from
  `SearchCriteriaSchema`, and a spec fails when the contract adds one. The tabs, sorts, `q`'s
  minimum and `limit`'s bounds would drift in silence.
- No authentication, no per-viewer overlay (`watchVerdict`, `viewerRelations`, `viewerProgress`),
  no internal token toward catalog (`adr-auth.md` §8).
- No drain window on shutdown, like the services.
