## Binding a route to its contract operation

A route that implements an operation of `@arthome/contracts/storefront-api` or `/studio-api` is
declared once, in core, and bound here by `@Endpoint(route)` from `@arthome-platform/http-edge`.
The decorator is `applyDecorators` over real decorators only, filled from the declaration: the
method and path (`@Get`, `@Post`... with the `{id}` template written `:id`), `@HttpCode` of the
lowest declared 2xx, `@ApiOperation` (operation id, summary, description), `@ApiTags`,
`@ApiResponse({ status, standardSchema })` for every declared status, `@ApiSecurity` for every
requirement, `@ApiParam`, `@ApiQuery` and `@ApiHeader` for every declared parameter and `@ApiBody`
for the body (Swagger reads no input of a custom decorator such as `EndpointInput`). A
requirement written `{}` (a call with no credential) is `ApiSecurity({})`.

```ts
const { getDateDetail } = storefrontApi.routes;

@Controller() // the route's path is unversioned: `Endpoint` adds Nest's `@Version`
export class DatesController {
  @Endpoint(getDateDetail)
  public async detail(
    @EndpointInput(getDateDetail) { params, headers }: HandlerInput<typeof getDateDetail>,
  ): Promise<HandlerOutput<typeof getDateDetail>> { /* { data, validUntil? } */ }
}
```

- **Versioning is Nest's, and the body ceiling the route's.** `Endpoint` routes `route.path`
  (without `/v1`) and adds `Version(String(route.version))`; the app calls `serveEndpoints(app)`
  (http-edge) before `init()` and `mountDevDocs`, and a suite passes `configure: serveEndpoints` to
  `httpApp` or calls it itself. It turns URI versioning on, and sets each route's `bodyLimit` as
  its Fastify body limit (1 MiB by default, 2 MiB on a batch), which only an `onRoute` hook can do.
  Never route `versionedPath(route)`: with versioning on it answers on `/v1/v1/...`.
- **Inputs** come in one decorator, `@EndpointInput(route)`, typed `HandlerInput<typeof route>`:
  `{ params, query, body, headers, principal }`, each part validated against the route's schema
  and every failing field named at once in `api.schema_invalid`'s `fields`; `@EndpointPrincipal(route)`
  gives the principal alone.
- **The handler returns data, the server stamps the envelope.** The handler must be `async` and
  return core's `HandlerOutput<typeof route>`: the route's success body without `servedAt`
  (`{ data }`, `{ data, validUntil }` on a perishable read, `{ items, page }` on a list), which
  `SuccessEnvelopeInterceptor` stamps on it. A handler returning anything else fails at the
  decorator, naming `the handler answers outside its route` and the output it owes; a
  `MemorisedResponse` is replayed as stored, with the `Idempotency-Replayed` and
  `X-Arthome-Served-At` headers core declares beside each other (`markReplayed`, which a BFF
  handler relaying a service's replay calls itself). `CollectionResponse` and `PerishableResponse` are for
  the routes no contract binds yet. `successSchemaOf(route)` is the success body's schema (the
  lowest 2xx's), for a relay that validates an upstream answer.
- **A route declaring several success statuses** (purchaseSeat and checkoutCart 201 or 202,
  setSubscriptionPlan 200 or 202) is answered `{ status, body }`, core's `HandlerOutput` for it.
  `SuccessEnvelopeInterceptor` stamps the body, `EndpointResponseInterceptor` shapes it by that
  status's declaration (a status the route does not declare answers 500, logged), and an `onSend`
  hook `serveEndpoints` installs sends the status, since Nest re-applies `@HttpCode` after the
  handler; a refusal raised after the choice keeps its own status. Such a route cannot answer a
  `MemorisedResponse` (the decorator refuses it), which carries no status to replay.
- **A refusal names its route**: `throw refuse(route, code, params)`. Only a code the route's type
  declares compiles (in its error responses or its `errors` list, the group's included), with the
  params core's `ERROR_PARAMS` gives it, at the status core's `ERRORS` registry gives it. A code
  the route's runtime `errorCodes` leaves out at that status is still answered, and logged naming
  the route. `refusalOf(code, params)` stays for code no route reaches.
- **Only the storefront BFF binds the public contract.** Catalog and ticketing keep their own
  routes until their INTERNAL contracts exist (their paths and headers differ); they are not bound
  here and serve no Swagger UI. Streaming is born on its internal one,
  `@arthome/contracts/streaming-service-api` (D-121): its routes bind it, and it mounts that
  contract's Swagger UI (`mountStreamingDocs`).
- **Access comes from the route** (ADR contract model §4.5). A route declared through the builder
  with `.identity(...)`, `.public()` or `.optionalAuth()` and its `requires` is guarded by
  `EndpointAccessGuard`: the identity's guard first, bound under the identity's name, then each
  rule's guard in its declared order. The table is the process's, given to `endpointProviders`
  (listed before every other global enhancer): the BFF binds `viewer` (the session, and the CSRF
  token of a cookie write, from the identity's write schemes, except on a route declaring
  `csrfExempt`; a refused credential is none on a route declaring `refusedCredentialIsAnonymous`), `viewer_or_device` (the viewer, then
  the paired device, whose token nothing verifies yet, so it is refused) and `throttle` (a bucket is
  a cap of core's `AuthRateLimit`, `CAPS_OF_BUCKET` being the one map from bucket to caps; the rule
  counts nothing and fails the boot on a bucket with no cap, the global `AuthThrottlerGuard` counts
  the caps of the buckets the route's contract declares); every service binds `service` (`ServiceIdentity`: the internal token,
  verified as `InternalTokenGuard` does, which leaves a route declaring an access to it; the
  principal is core's `{ callingService, userId, profileId?, deviceId? }`, from the token's `iss`,
  `sub`, `pro` and `did`, a claim the token lacks absent, never null) and `callerService`
  (`CallerServiceRule`: a calling BFF the rule does not name is refused 403 `api.forbidden`, and a
  rule naming no issuer, or one no BFF mints as, fails the boot). On a
  service, a route the contract declares public, or optional (which lets a call without a token
  in as well), fails the boot unless `edgeProviders`' `publicRoutes` names it (empty today):
  reached in the cluster without TLS, a service has the token as its only authorisation
  (transport.md §5.1). A name with no guard, or a rule its guard
  cannot enforce, fails the boot. The handler receives the identity's principal, stripped to its
  schema: `null` only on an `optionalAuth` route, `undefined` on a public one.
- **Routes bound without an access keep the legacy guards** until their module opts in, and the boot
  lists them: `InternalTokenGuard` and `DenyInProductionGuard` on the services. The BFF's global
  `CsrfGuard` and `AuthThrottlerGuard` stay as a second line and read the route's contract:
  `csrfExempt` is the only exemption besides a public route, and the caps come from the declared
  buckets. The BFF refuses to boot on a controller method that serves a path without `@Endpoint`
  (`ContractRoutesOnly`, `HealthController` apart). `@AllowInProduction()` stays where it was.
- **The answer is shaped from the route** by `EndpointResponseInterceptor`, around the success
  envelope: it is parsed through core's stripping schema of the success body
  (`strippingBodiesOf(route)`), so a field the route does not declare never leaves, even where the
  schema is loose for the client, and a body outside the declaration answers 500 `api.internal`
  with the route and the paths in the log, never a value; a `restricted` field the principal lacks
  the right for is removed (absent, never null;
  the rights are the principal's `rights` and `signedIn` for any identified caller), `Cache-Control`
  and `Vary` come from the route's `cache` (`public` for an anonymous caller only, `private` for
  any identified one), `no-store` from a sensitive field in the answer, and an
  identity's own headers from its guard (the studio's rights version).
- **A body, or a trace attribute holding one, is logged only through `redactSensitive(route, body)`**
  (http-edge; a schema works too): every field the route marks `sensitive`, a password, a token, a
  stream key, becomes `[redacted]`.
- **Budgets are the routes'** (transport.md §5.9). A BFF handler gives its calls the deadline of
  its own route's budget, `serviceCallFor(..., budgetOf(route), ...)`, and a call to a route that
  declares a budget of its own is given up at its end when that comes first,
  `withinBudget(call, calledRoute.budgetMs, clock)`. `AUTHENTICATION_WRITE_BUDGET_MS` stays until the
  authentication routes declare a budget.
- **What Fastify refuses before the handler leaves in the envelope too**: a malformed JSON body
  400 `api.schema_invalid`, a body over 1 MiB 413 `api.payload_too_large`, an unknown route 404
  `api.not_found`, and any body that is not JSON 415 `api.unsupported_media_type`.
  `JsonBodiesOnly` (http-edge, bound by `edgeProviders` and the BFF's `AppModule`) removes the
  `text/plain` and form parsers Fastify and Nest add by default (transport.md §5.7); a route that
  needs another body, auth slice B's `form_post` callback, will add its parser in its own scope.
- **Every response a suite provokes is checked against its route** (ADR contract model §7.3):
  `const responses = guardDeclaredResponses(storefrontApi)` at the top of the file, and
  `responses.watch(app)` before `app.init()`. A status the route does not declare, or a code its
  response does not name, fails the test, the code being compared with the route's `errorCodes` at
  every error status; `ARTHOME_UNDECLARED_RESPONSES=report` lists them at the end of the file
  instead. Run by an agent, Vitest picks its `minimal` reporter, which hides a passing file's
  output: pass `--reporter=default` to read the list.
- **Swagger UI, in development only**: `mountDevDocs(app, api, { docs, path: 'docs' })` mounts
  the page and its raw document (`/docs-json`) when `NODE_ENV` is `development` or `test`, and
  mounts nothing otherwise. `docs` is the api's docs module, `@arthome/contracts/storefront-api/docs`
  or `/studio-api/docs`, imported by a server only: its introduction titles the page (a `title`
  option names a service serving part of the api), and it gives the servers, tags and security
  schemes, and each operation's description and doc-only `x-arthome-*` (`Endpoint` writes no
  description). The document is built from the controllers of the process, so each lists only the
  operations it serves, with the api's named schemas as shared `$ref` components. The BFF mounts
  it through `mountStorefrontDocs(app)`.

| Process | Development port | Swagger UI | Operations |
| --- | --- | --- | --- |
| `bff-storefront` | 3003 | `http://localhost:3003/docs` | search, getDateDetail, getArtistDetail, resolvePublicLink, signUp, signIn, signOut, confirmEmailVerification, resendEmailVerification, getViewerContext, revokeDevice, signOutProfile, openPlayback, renewPlaybackTicket, releasePlayback |
| `streaming` | 3005 | `http://localhost:3005/docs` | getRunConsole, runTechnicalCheck, rehearseRun, goOnAir, endRun, resetRun, raiseIncident, resolveIncident, openPlayback, renewPlaybackTicket, releasePlayback, recordPlaybackPosition, getViewerProgressBatch, authorizeMediaServerAccess |

`@nestjs/swagger` is a peer of `libs/http-edge`; `@fastify/static` serves the UI on Fastify, and
`@scarf/scarf` (swagger-ui-dist's telemetry install script) is denied in `pnpm-workspace.yaml`.
The `command` schematic generates a route of its own, for a command no contract declares; bind it
with `@Endpoint` only when a contract operation is later declared for it.

