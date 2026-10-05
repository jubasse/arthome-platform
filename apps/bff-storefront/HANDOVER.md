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
| `src/search/search.controller.ts` | the route, bound to `storefrontApi.routes.search` with `@Endpoint`: deadline, the call, the public cache headers |
| `src/upstream/service-client.ts` | the one way this BFF calls a service: a fresh internal token, the deadline, the trace, the answer validated, the refusal relayed or mapped |
| `src/internal-token.minter.ts` | the token each call carries: ES256, this BFF as issuer, the service as audience, 60 s |
| `src/catalog/catalog.client.ts` | catalog's adapter on `ServiceClient`, always anonymous: the public reads serve every caller one body |
| `src/identity/identity.client.ts` | identity's adapter: the relayed authentication calls and the session's resolution |
| `src/auth/auth.controller.ts` | `/v1/auth/*`, bound to the contract's routes: its bodies and headers, the delivery mode |
| `src/auth/auth-rate-limits.ts`, `throttler-storage.ts` | the caps of core's `AuthRateLimit`, counted in Redis, refused as `api.rate_limited` |
| `src/session/` | the session's two carriers, the viewer, `ViewerIdentity`, `CsrfGuard` and the plugins they rely on |
| `src/viewer-context/` | `getViewerContext` and the composition `SessionEstablished` reuses |
| `src/dates/dates.controller.ts` | `GET /v1/dates/:dateId`, `GET /v1/artists/:artistId` and `GET /v1/resolve`, relayed from catalog |
| `src/conditional-get.ts` | the `ETag` and the `onSend` hook that answers a matching `If-None-Match` with 304 |
| `src/traceparent.middleware.ts` | a `traceparent` on every request that arrives without a valid one |

Proven by `src/catalog/catalog.client.spec.ts` (a stand-in catalog over HTTP), the two
`*.e2e.spec.ts` (the whole app through Fastify), `src/conditional-get.spec.ts`,
`src/auth/auth.e2e.itest.ts` (this BFF against the real identity, Postgres and Redis), and on the
running stack (`AGENTS.md`, "Search, the date page and link resolution, from the storefront BFF").

Every route here is bound by `@Endpoint(route)` to its `storefrontApi` declaration (`AGENTS.md`,
"Binding a route to its contract operation"): there is no hand copy of a query, a body or a
response left, and the upstream answers are validated against `successSchemaOf(route)`. The
development Swagger UI is at `http://localhost:3003/docs`, mounted by `main.ts` from the
contract's docs module (`storefront-docs.ts`) and absent in production.

## 2. Decisions, and why

- **The deadline is 200 ms out**, transport.md §5.9's search budget, sent as `x-arthome-deadline`
  and armed locally with `AbortSignal.timeout` on the same instant. The surface hanging up aborts
  the call too.
- **Only the codes the BFF route declares cross**, with their params, at the status core's error
  registry gives them: the call carries its route (`serviceCallFor`'s last argument, `route` on a
  `CatalogCall`). A code about the call itself (a 5xx, or a 4xx core derives on every route but
  `api.schema_invalid`: the token, the limits) never crosses, declared or not. A guard's call,
  which serves no route, keeps `STOREFRONT_RELAYED_CODES` (`@arthome/contracts/envelope`, where
  transport.md §5.5 puts the allowlist) at the service's status. Catalog's `api.deadline_exceeded`
  becomes `api.upstream_timeout`; anything else, a 2xx outside the contract included, becomes
  `api.upstream_unavailable`, and the original is logged with the `traceparent`. No retry here:
  the surface is the one layer that retries.
- **A `traceparent` is created when the surface sent none or a broken one**, on the request itself:
  the error filter reads it there, and the storefront `Error` requires a `traceId`.
- **`Cache-Control: public, max-age=60`** for an anonymous caller, and the contract's `Vary`; a
  signed-in viewer is answered `private, max-age=60` (core's `cacheControlOf` takes the caller),
  so no shared cache keeps a page served to them once a session adds overlays.
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
- **The session is identity's, validated here** (§8): a route declared with the `viewer` identity
  is resolved by `ViewerIdentity`, bound in `AppModule`'s `endpointProviders`, which also checks a
  cookie write's CSRF token (not on a `csrfExempt` route) and counts a refused credential as none
  where the route declares `refusedCredentialIsAnonymous` (sign-out). Public routes never wait on
  identity. `viewer_or_device` is `ViewerIdentity` first, then `ViewerOrDeviceIdentity`'s
  device token, verified by `PairedDeviceVerifier`: `NoPairedDevices` is bound until pairing is
  built, so a device token alone answers 401. No Redis
  cache of sessions yet: one identity call per authenticated request, within transport.md §5.9's
  150 ms. Identity answers an unknown session `session: null`, so a 401 from identity means this
  BFF's own token was refused, and becomes `api.upstream_unavailable`.
- **The mode is the surface's explicit choice** (D-023): `cookie` sets `__Host-arthome_session`
  (the contract's name, `HttpOnly`, `Secure`, `SameSite=Lax`), the readable `__Host-arthome_csrf`
  and the CSRF secret, with nothing in the body; `bearer` and `device` answer the token in the
  body, `refreshToken` null, and set no cookie. A request carrying both carriers is a 401. The three
  cookies are `__Host-`, so a sibling subdomain cannot plant a session of its own. They live as long
  as the session; sign-out clears them with the attributes that set them, and `getViewerContext`
  re-sets all three with the session's slid expiry. Signing in or up over a session closes that
  session, best effort, so it does not live on for seven days in a browser that dropped it.
- **CSRF**: every write carrying the session cookie needs `X-Arthome-Csrf` (storefront.yaml
  `sessionCookie`), checked by `@fastify/csrf-protection` with the token bound to the session. From
  a guard rather than the plugin's hook, so a refusal leaves through the error envelope. Sign-up,
  sign-in and the email link open no session and are exempt. Sign-out is exempt too: a forged one
  grants nothing, its required headers cannot cross origins without a preflight this BFF never
  answers, and a browser that lost its secret must still be able to sign out.
- **No CORS is configured**, which denies every cross-origin call: right for a web surface served
  from the BFF's origin. A cross-origin surface needs an explicit allow-list per environment, never
  `origin: true` with credentials (`nestjs-web-security` rule 3). No helmet either: the BFF serves
  JSON alone.
- **The caps** (`adr-auth.md` §6.2) count per address until devices carry a verified identity: the
  product owner's direction is to limit by device, which slice C brings. Until then an IPv6 /64
  keeps tight caps, and an IPv4 address gets core's high anti-abuse ceiling (300 sign-ins per 15
  minutes, 60 sign-ups per hour), since carriers share one IPv4 address across hundreds of
  subscribers (CGNAT) and D-079's openings would refuse real viewers. Password guessing is capped
  per typed email and address, a resend per account.
  In Redis, so every replica shares them. `TRUSTED_PROXIES` names the proxies whose
  `X-Forwarded-For` is believed. It is required in production, `none` when no proxy fronts the
  BFF: trusting none behind a proxy would make every client the proxy's address and the caps
  platform-wide. Outside production it defaults to none.
- **No lockout per email** (the lead's ruling, 2026-10-03): an email's wrong passwords, from any
  address, hold its next sign-in for a doubling pause bounded at four seconds (`FailedSignIns`,
  core's `SignInSlowdown`), and never refuse it; a success clears the count. A stranger who knows an
  address can slow its owner by four seconds, never sign them out (`auth.e2e.itest.ts`, "never
  locks the owner out"). The pause holds a connection: the per-address caps bound how many. It
  costs a sequential guesser latency and does not slow a spray: the bound on guessing is ten per
  (email, address or /64) per fifteen minutes, times the attacker's networks (the re-review's F5b,
  accepted for slice A). Slice C tightens it with OWASP's device cookies.
- **The country at sign-up** is the gateway's geolocation header, named by `VIEWER_COUNTRY_HEADER`,
  or `ZZ`, CLDR's unknown region, when the header is missing or holds no country: the surface is
  never asked, and no other header is trusted. The variable is required in production (the lead's
  ruling, 2026-10-03), so a deployment cannot record every country as unknown in silence; outside
  production it is unset and every country is `ZZ`. The BFF believes that header from whoever sends
  it, so **the gateway must strip or overwrite it on every client request**, a deployment
  requirement. The impact is low: the country only feeds `AccountRegistered`, and every read
  evaluates it again.
- **The viewer context is the contract's type** (`ServedViewerContext`), served from the session
  `ViewerIdentity` resolved: identity answers the account with it, so `getViewerContext` makes one
  identity call, within §5.9's session validation. The label catalogue and the taxonomy artifact
  are `null` until a publication pipeline exists (core's CI, context-map §1.8): the surface uses its
  embedded snapshot. The reaction quota per date is omitted until the product owner gives the
  number; `sendReaction` returns the remaining quota (realtime.md §2.3). Every other constant comes
  from its owner in core, `previewSecondsTotal` included.
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
- `getViewerContext` accepts no `device_token` yet (auth slice C).
- **Session validation at scale**: one identity call per signed-in request, no cache. At an
  opening's scale a slow identity turns every signed-in call into a 504; `adr-auth.md` §8's Redis
  cache of sessions is the follow-up, measured by T6's load test.
- **`resendEmailVerification` answers `queued`, not `sent`** (the lead's addendum): the link is
  recorded for `notifications`, which owns the sending and has no consumer of the verification
  topic nor mail adapter yet. Sending it is a launch prerequisite.
- **Service-to-service HTTP is assumed private**: `IDENTITY_URL`, like `CATALOG_URL`, accepts
  `http` in production, and session tokens and internal tokens ride on it. Production runs the
  services on a private network or a mesh with mTLS; `JWKS_URL` is held to `https` because the CDN
  is outside it.
- **The JWKS document has no publisher**: infrastructure's (`definition-of-done.md` §7.6, J1 to
  J3). The key ceremony publishes `bff-sf-<date>` before this BFF signs with it.
- The `deviceId` a sign-up or sign-in body asserts is ignored until devices register: the viewer's
  device is the session's own id.
- No drain window on shutdown, like the services.

## 4. What slice B must do first

The architecture review's P2 to P5, in order:

1. **Record the actor of every write.** `libs/messaging`'s `outboxWriter` still writes
   `actorId: null`, on the premise that no actor was verified, which slice A made false. identity's
   `writeOutboxEvent` sets it; catalog and ticketing do not. Feed `ServiceEvent.actorId` from the
   principal, and have `ServiceClient` send `x-arthome-actor-surface` on every human write
   (transport.md §5.2); it sends neither today. An actor not recorded cannot be rebuilt (events.md),
   so every purchase written before this loses its buyer as actor.
2. **Make an account route require an account by default.** `CurrentPrincipal` hands any handler
   an anonymous principal, and each must remember `accountOf`. The studio commands pass a nullable
   `principal.accountId` into the idempotency scope (catalog's dates and artists controllers,
   ticketing's date-sales controller), and the `command` generator emits that shape. Add a
   `@CurrentAccount()` parameter decorator, 401 without `sub`, as the generator's default;
   `CurrentPrincipal` stays for routes that serve anonymous visitors.
3. **Authorise the studio's routes before any `AllowInProduction`.** They accept anonymous tokens
   today. Require an account, authorise on the loaded instance (critical rule 5), and check the
   issuer or the roles only the studio BFF mints: `Principal.issuer` is carried and checked nowhere.
4. **Give the studio BFF a development key.** The development key and the local JWKS know
   `bff-sf-development` alone (`libs/config/src/development-token-key.ts`), so every service refuses
   a studio token in development until a `bff-st-development` key is published beside it, refused
   in production by its coordinates as this one is. The minter is storefront-only.
5. **Give identity ticketing's shape**: `CqrsModule`, a `TransactionRunner` and an `outboxWriter`
   topic table, before the `aggregate` and `command` generators can produce Channel, membership and
   invitation. A's flows straddle better-auth's store and identity's, so plain services fit them.
6. **Extract the BFF plumbing into a library** (recommended): `libs/bff-edge`, with the minter
   parameterised by issuer, `ServiceClient`, the session carriers, `CsrfGuard`, `FailedSignIns` and
   the throttler wiring, before `bff-studio` exists. Two copies of token minting, CSRF and the error
   allowlist would drift. The routes, the caps used and CORS stay per BFF; the studio's CORS allows
   the literal Capacitor origins (`adr-auth.md` §6.6).

B's own caps: the studio's limits count per authenticated member, not per address, and are set
high, since a moderator or a stage manager may work several dates at once.

Also open for B: the claims `chn` and `rol` (and `scope`) in `InternalTokenClaimsSchema`, loose so
A's services keep working; studio.yaml's `bearerToken`, which describes a device-bound refresh token
against the storefront's sliding session; `CHANNEL_ACCESS_REVOKED`, the studio's reset confirmation
and Q4's invitation sign-up, not in core yet.
