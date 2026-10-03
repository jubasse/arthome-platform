# `bff-storefront` — handover

The storefront's BFF (`context-map.md`: one BFF per product, owned by its surfaces). It serves
`openapi/storefront.yaml` from the services behind it and holds no domain rule. From catalog:
`GET /v1/search`, `GET /v1/dates/:dateId`, `GET /v1/artists/:artistId` and `GET /v1/resolve`. From
identity (auth slice A, D-107, 2026-10-03): `/v1/auth/sign-up`, `sign-in`, `sign-out`, `verify-email`,
`verify-email/resend` and `GET /v1/viewer-context`.
Written 2026-09-26, the date routes 2026-09-27, the authentication relay 2026-10-03.

## 1. What was built

| File | What it is |
| --- | --- |
| `src/search/search.controller.ts` | the route: surface check, deadline, the call, the public cache headers |
| `src/search/search-query.schema.ts` | the contract's query parameters, query-string values coerced |
| `src/search/search-response.schema.ts` | the 200 body, composed from `@arthome/contracts` |
| `src/upstream/service-client.ts` | the one way this BFF calls a service: a fresh internal token, the deadline, the trace, the answer validated, the refusal relayed or mapped |
| `src/internal-token.minter.ts` | the token each call carries: ES256, this BFF as issuer, the service as audience, 60 s |
| `src/catalog/catalog.client.ts` | catalog's adapter on `ServiceClient`, always anonymous: the public reads serve every caller one body |
| `src/identity/identity.client.ts` | identity's adapter: the relayed authentication calls and the session's resolution |
| `src/auth/auth.controller.ts`, `auth-requests.schema.ts` | `/v1/auth/*`, the contract's bodies, the delivery mode |
| `src/auth/auth-rate-limits.ts`, `throttler-storage.ts` | the caps of core's `AuthRateLimit`, counted in Redis, refused as `api.rate_limited` |
| `src/session/` | the session's two carriers, the viewer, `ViewerGuard`, `CsrfGuard` and the plugins they rely on |
| `src/viewer-context/` | `getViewerContext` and the composition `SessionEstablished` reuses |
| `src/dates/dates.controller.ts` | `GET /v1/dates/:dateId`, `GET /v1/artists/:artistId` and `GET /v1/resolve`, relayed from catalog |
| `src/conditional-get.ts` | the `ETag` and the `onSend` hook that answers a matching `If-None-Match` with 304 |
| `src/storefront-surface.ts` | the `X-Arthome-Surface` check and the contract's `Vary`, for every route |
| `src/traceparent.middleware.ts` | a `traceparent` on every request that arrives without a valid one |

Proven by `src/catalog/catalog.client.spec.ts` (a stand-in catalog over HTTP), the two
`*.e2e.spec.ts` (the whole app through Fastify), `src/conditional-get.spec.ts`,
`src/auth/auth.e2e.itest.ts` (this BFF against the real identity, Postgres and Redis), and on the
running stack (`AGENTS.md`, "Search, the date page and link resolution, from the storefront BFF").

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
- **Every call to a service carries an internal token** (`adr-auth.md` §8): minted per call, never
  forwarded, naming the viewer's account and device, or no account for an anonymous visitor.
  `DenyInProductionGuard` stays bound behind the others, and every route here is allowed in
  production now that the services can verify who calls them.
- **The signing key** comes from `INTERNAL_TOKEN_SIGNING_KEY`, required in production. Outside it,
  the development key `libs/config` publishes (`development-token-key.ts`) signs, so a fresh clone
  runs. Production refuses that key by its public coordinates, under any `kid`, which
  `libs/config/src/auth-env.spec.ts` proves; so are the development better-auth, CSRF and payment
  webhook secrets. A service drops that key from any JWKS document it fetches
  (`internal-token.verifier.spec.ts`), so a CDN document that carried it by mistake still verifies
  nothing it signed (approved by the lead, 2026-10-03). The minter refuses a key whose `kid` is not
  `bff-sf-`.
- **The session is identity's, validated here** (§8): `ViewerGuard` asks identity on the routes
  marked `RequiresViewer`, and nowhere else, so a public read never waits on identity. No Redis
  cache of sessions yet: one identity call per authenticated request, within transport.md §5.9's
  150 ms. Identity answers an unknown session `session: null`, so a 401 from identity means this
  BFF's own token was refused, and becomes `api.upstream_unavailable`.
- **The mode is the surface's explicit choice** (D-023): `cookie` sets `arthome_session` (the
  contract's name, `HttpOnly`, `Secure`, `SameSite=Lax`) and the readable `arthome_csrf`, with
  nothing in the body; `bearer` and `device` answer the token in the body, `refreshToken` null, and
  set no cookie. A request carrying both carriers is a 401. Sign-out clears with the attributes that
  set; `getViewerContext` re-sets both cookies with the session's slid expiry.
- **CSRF**: every write carrying the session cookie needs `X-Arthome-Csrf` (storefront.yaml
  `sessionCookie`), checked by `@fastify/csrf-protection` with the token bound to the session. From
  a guard rather than the plugin's hook, so a refusal leaves through the error envelope; sign-up,
  sign-in and the email link open no session and are exempt.
- **The caps** (`adr-auth.md` §6.2) count per address until devices carry a verified identity, per
  typed address for password guessing, per account for a resend; in Redis, so every replica shares
  them. `TRUSTED_PROXIES` names the proxies whose `X-Forwarded-For` is believed, none by default.
- **The country at sign-up** is the gateway's geolocation header, named by `VIEWER_COUNTRY_HEADER`,
  or `ZZ`, CLDR's unknown region, when the header is missing or holds no country: the surface is
  never asked, and no other header is trusted. The variable is required in production (the lead's
  ruling, 2026-10-03), so a deployment cannot record every country as unknown in silence; outside
  production it is unset and every country is `ZZ`.
- **The viewer context serves what has an owner**: the auth half and core's constants. The reaction
  quota per date, the label catalogue and the taxonomy artifact have no owner yet, and
  `ServedViewerContext` says so; the contract requires all three.
- **The date page answers 304 from a Fastify hook, not from its handler**: Nest 12.0.3's
  `FastifyAdapter.reply` sets the route's status back to 200 after the handler returns. The
  `ETag` is weak and hashes `data` and `validUntil`, never `servedAt`, which always moves. The
  hook is registered in `main.ts`, and a test app must register it too.
- **Budgets**: 200 ms for the search, 400 ms for the date page, the artist page and the
  resolution (transport.md §5.9's composed public read). The e2e suites pin the controllers'
  clock an hour ahead, so no deadline falls due under verify's load, and each reads its budget
  exactly from the deadline the stand-in catalog received.
- **Readiness checks nothing downstream**: a catalog outage fails searches, it must not take the
  BFF out of rotation.

## 3. Known gaps

- **The query schema is a hand copy of `storefront.yaml`'s parameters.** D-058 gives `paths` no zod
  source, so `check-emit-diff` does not compare them; only the criteria come from
  `SearchCriteriaSchema`, and a spec fails when the contract adds one. The tabs, sorts, `q`'s
  minimum and `limit`'s bounds would drift in silence.
- No per-viewer overlay (`watchVerdict`, `viewerRelations`, `viewerProgress`): catalog is called
  anonymously.
- `getViewerContext` lacks the contract's `labelCatalog`, `taxonomyArtifact` and
  `constants.reactionQuotaPerDate` (above), and accepts no `device_token` yet (auth slice C).
- The `deviceId` a sign-up or sign-in body asserts is ignored until devices register: the viewer's
  device is the session's own id.
- No drain window on shutdown, like the services.
