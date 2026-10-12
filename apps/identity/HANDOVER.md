# `identity` — handover

The storefront session (auth slice A, 2026-10-03): sign-up, sign-in, the session's resolution and
revocation, the viewer's account and the email verification link, all called by the storefront BFF
behind the internal token, on better-auth 1.7.5 used as a library. The account is written with its
events through the outbox in one transaction, the inbound `traceparent` injected at write time.

> **THIS FILE DID NOT EXIST UNTIL 2026-09-25, AND ITS ABSENCE WAS ITSELF A DEFECT.** `catalog`
> wrote a handover and `identity` did not, so identity's debt was recorded nowhere — and the one
> place it *was* described, `apps/catalog/HANDOVER.md` §2(e), described it **second-hand and got it
> wrong**: it said identity could "afford" unvalidated `locale` and `country` because a wrong value
> on the wire "stays visible". That inverts for a wrong *type*, and the inversion was live. A
> service that documents nothing is a service whose gaps get described by someone who did not write
> it.
>
> §2 and §3 record the service before auth slice A, reconstructed from the code by the author of
> the HTTP-edge pass. Where they name `POST /accounts`, sign-up replaced it on 2026-10-03 (§0); the
> lessons they record still bind `SignUpSchema`.

## 0. Auth slice A

**better-auth is a library here, not a set of routes** (`adr-auth.md` §3.1, as the platform
implemented it). `src/auth/better-auth.ts` builds the instance; identity's own controllers call
`auth.api`; no better-auth route is mounted, so every route sits behind the internal token's guard
and a caller reaching identity directly cannot skip the BFF's caps, which is what bounds
enumeration (D-099). `@thallesp/nestjs-better-auth` is not installed, and `bodyParser: false`
therefore applies nowhere. Approved by the lead on 2026-10-03 and recorded as an amendment to
`adr-auth.md` §3.1, not as a decision.

**What bounds password guessing** is the BFF's cap per (email, address or /64): ten wrong passwords
per fifteen minutes, times the networks an attacker holds (the re-review's F5b, accepted for slice
A). There is no lockout per email, so nobody can sign an owner out, and the BFF's slow-down only
delays a sequential guesser. **Slice C** tightens the bound with OWASP's device cookies: a device
that once signed the owner in is recognised and keeps its own allowance, so strangers' attempts can
then be held to far less.

| Route (BFF only) | What it does |
| --- | --- |
| `POST /v1/auth/sign-up` | the account, its two events and the first link, then the credential; `Idempotency-Key` required |
| `POST /v1/auth/sign-in` | the password checked by better-auth, then the account's status; never idempotent (the contract's prohibition) |
| `POST /v1/sessions/resolve` | `{ session }` with its device, binding, profile and `account` (handle, verified), so the viewer context costs the BFF one call; null for a token that opens nothing, or whose binding is closed or device revoked (§0b); a 401 from here only ever means the BFF's own token |
| `POST /v1/sessions/revoke` | this session alone, and its binding; succeeds on a session already gone |
| `GET /v1/accounts/me` | the handle and whether the address is verified, for the token's `sub`; no BFF route calls it since `resolve` answers the same |
| `POST /v1/accounts/me/email-verification` | a fresh link, the earlier ones spent: `queued`, since `notifications` owns the sending; `queued: false` once verified |
| `POST /v1/email-verifications/confirm` | spends the token and verifies the address |

**Two stores, one UUIDv7.** better-auth's tables are in the `auth` schema on Kysely, TypeORM's in
`public` (R2). The account's id is generated first and handed to better-auth through
`advanced.database.generateId` and an `AsyncLocalStorage` (`withPresetUserId`), so a join reads
`account.id::text = auth."user".id` (better-auth types its ids `text`). `pnpm run migration:auth`
runs better-auth's migrator; `migration:run` stays TypeORM's; either order works, and
`auth-schema.itest.ts` keeps spike S1 as a regression.

**The order of a sign-up is the design** (`sign-up.service.ts`). Identity's transaction claims the
idempotency key, inserts the account with `ON CONFLICT DO NOTHING` (a taken address is 409
`identity.email_taken` without aborting the transaction, 765134a; a taken handle is retried with
fresh bytes), writes `identity.account.registered.v1` and the first verification link, then lets
better-auth write the credential on its own connection, then commits. A refused credential rolls
everything back; a commit that fails after the credential exists removes the credential; a crash
between the two commits leaves a credential with no account, which the next sign-up of the address
finds (better-auth says the address is taken while the account row was free) and replaces.

**Passwords** are argon2id at OWASP's floor (`password-hashing.ts`), between 12 and 128
characters, NFKC-normalised before hashing and verifying; a sign-in hashes again a digest made with
older parameters, so raising them reaches every account that signs in. **better-auth's `baseURL`**
is `PUBLIC_WEB_ORIGIN`, required in production: the public origin the surfaces and the BFF share
(`adr-auth.md` §8.2.7), never identity's internal address. No link better-auth builds is sent today;
a reset link (slice D) overrides `sendResetPassword` to point at the surface. **Sessions** live 7 days and slide once a day (`@arthome/core`'s lifetimes, owned by
`adr-auth.md` §6.1); the token handed out is the signed one, and `bearer({ requireSignature: true
})` refuses an unsigned one. **The idempotency fingerprint of a sign-up is keyed**
(`keyedFingerprintOf`, the key derived from `BETTER_AUTH_SECRET`): the body carries a password, and
the record keeps it for a day.

**The email verification link** (`adr-auth.md` §6.7, D-100) is identity's, not better-auth's,
whose token is a signed JWT a second use does not spend. 256 random bits, the hash alone stored in
`email_verification`, spent by its first use, expired after
`EMAIL_VERIFICATION_LINK_LIFETIME_HOURS`, bound to the address it was sent to; a resend spends the
earlier ones. `identity.email_verification.requested.v1` carries the token to `notifications`, in
clear, on a topic of its own, `arthome.identity.email_verification`, which `notifications` alone
may read (`events.md` §3): the account topic, which other contexts may read, never carries a token.
The token is never logged: identity logs none, and the connectors log a failed record's error, not
its payload (`infra/debezium/README.md`). The topic keeps the standard week, since a shorter
retention would make the republish check republish an expired link; the token dies with the link
anyway. Unknown, expired and used answer one 410 `identity.verification_link_invalid`.

**A password reset's token must NOT take this path.** It opens an account where this one only marks
an address verified; slice D decides how it reaches the person (the lead's ruling, 2026-10-03).

**One lock order** (the review checklist's): an account's row, then its links. `resend` locks the
account and spends the outstanding links; `confirm` reads the link, locks its account, then spends
the link. The race between the two is a suite case.

**The public handle** is generated and neutral (`generatedPublicHandle`, D-101), changeable
later through `updateProfile` (not yet served). **The country** is the one the BFF sends: the
gateway's geolocation, or `ZZ`, CLDR's unknown region. **The device id** the BFF puts in the token
is the registered device since PI1 (§0b), no longer the session's own id.

### What later slices inherit

- **B (studio)**: the studio BFF's issuer is already in `INTERNAL_TOKEN_ISSUERS`; the claims schema
  is loose for its `chn` and `rol`; Q4's invitation sign-up reuses `SignUpService`'s order. What B
  must do first, identity's CQRS shape included, is in `apps/bff-storefront/HANDOVER.md` §4.
- **C (devices)**: PI1 made `deviceId` the registered device and bound every session to a
  (device, profile) pair (§0b); PI2 adds `revokeDevice`, `signOutProfile` and their two events.
  Still owed: the native device (`registerDevice`, the ES256 `device_token`, pairing), more than
  one profile and the picker. The bearer plugin is in place; `multi-session` and
  `device-authorization` are not installed.
- **D**: password reset, two-factor, social sign-in. A reset token must not take the verification
  token's path: its delivery is D's decision. **Linking a social sign-in to an existing address**
  (D-106) must also require identity's own `email_verified_at`, or drop the password and revoke the
  sessions on link: D-100 lets a stranger register the address unverified, and that stranger's
  password would still open the account the owner later links (the security review's m7). From
  then on a verified address unlocks something, which ends the premise that lets the verification
  token travel in clear.
- **Nothing consumes `arthome.identity.email_verification` yet**: `notifications` records the
  welcome email only, and no email is sent by anyone today. Its consumer, when written, is the
  topic's only one (`verification-topic.spec.ts` fails on any other app naming it), and production
  enforces it with the ACLs `infra/kafka/README.md` requires.

## 0b. Profiles and devices (PI1)

Every storefront session belongs to a registered device and a profile (`data-model.md` §1.2-1.3,
`adr-auth.md` §4/Q3 and D-126). Three tables, migration `1791800000000`: `profile` (one default
`adult` profile per account, created in sign-up's transaction, backfilled for older accounts by
an `up` that may run twice), `device` (the browser, known by its token's digest alone) and
`device_session`, the (device, profile) pair a better-auth session is bound to, at most one open
per pair. Their uniques are indexes, not inline `UNIQUE`: no request can collide on them, so they
map to no refusal code.

**The seam PB1 and PB2 code against** (PI1's PRD §6; changing it needs the lead):

| Call | What changed |
| --- | --- |
| `POST /v1/auth/sign-up`, `/v1/auth/sign-in` | optional `device: { token: string \| null, kind, label }` (`kind` one of core's `DEVICE_KINDS`, `label` 1 to 80 characters); absent means `{ token: null, kind: 'desktop', label: 'unknown' }`. The answer adds `session.deviceSessionId`, `session.profile { id, name, kind }` and `device: { token }`, the token the BFF sets now |
| `POST /v1/sessions/resolve` | the session adds `deviceSessionId` and `profile`; `deviceId` is the registered device (UUIDv7) |
| `POST /v1/sessions/revoke` | also closes the session's binding, with its close event (§0c) |
| `POST /v1/devices/{deviceId}/revoke`, `/v1/device-sessions/{sessionId}/close` | served since PI2 (§0c) |

**The token's life.** 256 random bits in base64url (`devices/device-token.ts`), SHA-256 hex at
rest; the raw token appears in the sign-up and sign-in answer only, never in a row, a log or the
idempotency record. It lives `DEVICE_TOKEN_LIFETIME_SECONDS` from its last rotation, and rotates
**at sign-in only**, in one conditional `UPDATE ... WHERE token_hash = $old AND revoked_at IS
NULL AND token_expires_at > now`: of two sign-ins presenting one token, one rotates it and the
other registers a new device. An absent, unknown, expired or revoked token registers a new device
and never refuses the sign-in. Registration and rotation run only after better-auth accepted the
password and identity the account, inside one transaction with the binding; a failure there
revokes the fresh session. A session renewed daily is not a sign-in (D-126, accepted): a viewer who
does not sign in for the token's lifetime loses the cookie and gets a new device next time.

**The binding.** `DevicesService.bind` closes the pair's open binding, then inserts the new one
with `ON CONFLICT ... DO NOTHING` on the partial index: a second sign-in of one profile on one
device replaces the first, and a racing bind is retried once. The replaced better-auth session is
deleted after commit, best effort; its closed binding already resolves to nothing.

**Resolve fails closed.** After `getSession`, one statement reads the open binding by
`auth_session_id`, its unrevoked device, its profile and the account's sign-in status: still two
round trips (transport.md §5.9). No binding, a closed one or a revoked device resolves to null,
never to a fallback device. **Sessions opened before this migration have no binding: they resolve
to null, and the viewer signs in again.** Nothing writes on resolve: `last_seen_at` moves at
sign-in only.

**A replayed sign-up** answers `device.token: null`: nothing is re-set, and the fingerprint leaves
`device` out, so a browser that never got the first cookie still replays. While the recorded
session resolves, the replay answers the same ids; once it is gone, `reissue` opens a fresh session
bound to the recorded device (a new one if it was revoked) and the default profile, so the answer
keeps `deviceId` and `profile` with a new `deviceSessionId`.

**What proves it**: `devices/device-binding.http.itest.ts` (the seam's shapes, rotation, the
fail-closed resolve, the replay, the two races, a log capture holding neither token),
`profiles/default-profile.itest.ts` (the backfill, `up` twice, the race on a missing default),
`devices/device-token.spec.ts`, and the BFF's `auth/auth.e2e.itest.ts` unchanged.

## 0c. Revocation (PI2)

Two acts the storefront BFF relays for the account its internal token names (`sub`), each under
its `idempotency-key`, each writing its rows and its events in one transaction through the outbox
(`devices/device-events.ts`), on `arthome.identity.device`, key = the device id. Streaming consumes
both (`apps/streaming/src/devices/`) and refuses the next renewal `identity.signed_out_elsewhere`.

| Act | Rows | Event |
| --- | --- | --- |
| `POST /v1/devices/{deviceId}/revoke` | the caller's open bindings on the device closed; `device.revoked_at` only once no other account holds a binding there that still resolves | one `identity.device_session.closed.v1` per binding closed; `identity.device.revoked.v1` once, with the caller's account, when the device is revoked |
| `POST /v1/device-sessions/{sessionId}/close` | that binding's `closed_at` | one `identity.device_session.closed.v1` with its `profile_id`; `self_initiated` when the token's `did` is the binding's device |
| `POST /v1/sessions/revoke` (sign-out) | the session's binding closed | the same close event, `self_initiated: true`, the actor being the session's own account |

- **One device, several accounts.** A `device` row has no account: a browser keeps one device
  across sign-outs, so accounts share it. A revoke closes only the caller's bindings and never
  cuts another account's leases; the device is revoked by the last account holding it. Another
  account holds it only through a binding that still resolves (open, its better-auth session
  unexpired, its account still signing in): a binding left open after its session lapsed holds
  nothing, so it never keeps the device alive.
- **No cross-account reach.** A revoke needs an open binding of the caller on the device, read by
  the closing `UPDATE` itself under the device's row lock, so a close that wins the race leaves the
  revoke a 404; a close needs the caller's own binding. Anything else, an unknown id and a device revoked already answer
  `404 api.not_found`, and write nothing. A close of a binding closed already answers `200` with no
  event; a replayed key answers the first `200` with no second event.
- **What writes no event.** A sign-in of the same profile on the same device replaces the first
  binding (§0b) and says nothing: that pair stays signed in. A sign-out of a session already gone
  writes nothing, nor does the revoke of a session whose bind failed.
- **The actor.** `revoked_by` and `closed_by` carry the caller and the relayed
  `x-arthome-actor-surface`, unspecified when absent or unknown; the outbox row's `actor_id` is the
  verified caller.
- **After the commit**, the closed bindings' better-auth sessions are deleted, best effort, a
  failure logged with the binding ids: they resolve to nothing already (§0b).
- **The exposure window.** A revoked device keeps playing until its playback token's next renewal,
  at most 120 s (`adr-stream-entitlement.md` §3.3), plus the consumer's lag (Debezium, Kafka,
  streaming's consumer). Streaming bounds a profile's close by `occurred_at` against its own clock,
  so a lease opened within the skew between the two clocks may survive the close until its own
  expiry (accepted); a device revocation is unbounded for that reason. On a device another
  account still holds, the revoke writes no `identity.device.revoked.v1`: the caller's leases
  there end through the `occurred_at`-bounded close events, and only the last account's revoke is
  unbounded.

**What proves it**: `devices/device-revocation.http.itest.ts` (both acts, the shared device, one
whose other session lapsed, the 404s, a close or a second revoke racing the revoke, the replay,
sign-out's close and the replacement's silence, a commit that fails after the insert leaving
neither row nor event), `devices/device-events.itest.ts` (identity's rows shaped as
`infra/debezium/identity-outbox.json` places their columns, read by streaming's consumer: the
leases end and the renewal answers `403 identity.signed_out_elsewhere`),
`devices/device-events.spec.ts` (the wire maps, the payloads read back). PE1 proves the same through
the real connector and broker.

## 1. What is here

| File | What it is |
| --- | --- |
| `src/auth/account.entity.ts` | the domain's half of `Account`: handle, address, locale, country, `status` (`ACCOUNT_STATUSES`), `email_verified_at`, the accepted terms |
| `src/auth/email-verification.entity.ts` | one verification link, by its token's hash |
| `src/auth/better-auth.ts`, `password-hashing.ts`, `auth-migrations.ts`, `src/migrate-auth.ts` | better-auth's instance, its hashing, its migrator and the command running it |
| `src/auth/sign-up.service.ts`, `sign-in.service.ts`, `sessions.service.ts`, `email-verifications.service.ts`, `viewer.service.ts` | the routes' work |
| `src/auth/auth.controller.ts`, `sign-up.schema.ts`, `refusals.ts`, `auth.module.ts` | the routes, their bodies, their refusals, the wiring (better-auth's own pool, closed on shutdown) |
| `src/profiles/` | `Profile`, its kinds, `defaultProfileOf` (§0b) |
| `src/devices/` | `Device`, `DeviceSession`, the token and its digest, the presented device's schema, `DevicesService` (registration, rotation, binding) (§0b) |
| `src/migrations/1758700000000-initial.ts`, `1758700200000-outbox-guards.ts`, `1790500000000-storefront-session.ts`, `1791800000000-profiles-and-devices.ts` | the account and the outbox; the outbox CHECKs; slice A's columns, the links and the idempotency store; the profile, the device and the binding, with the default profile's backfill |
| `src/edge-providers.ts`, `src/app.module.ts`, `src/main.ts`, `src/data-source.ts` | the wiring: `edgeProviders`, so the internal token's guard comes first |

The shared HTTP edge — the exception filter, the internal token's guard, the production guard, the
refusal shape and the traceparent parser — is **`@arthome-platform/http-edge`** (`libs/http-edge`),
not a file in this service. §3.

Tests: `sign-up.schema.spec.ts`, `password-hashing.spec.ts`, `unique-violations.spec.ts`, and the
container suites `auth-schema.itest.ts` (S1), `auth.http.itest.ts` (the routes, the refusals, the
link's single use and expiry, two sign-ups racing, an orphaned credential replaced),
`devices/device-binding.http.itest.ts` and `profiles/default-profile.itest.ts` (§0b) and
`boot.itest.ts` (`AppModule` itself). The BFF's `auth.e2e.itest.ts` runs this service behind the
storefront BFF. `src/itest/` holds the harness both use.

**`unique-violations.spec.ts` EXISTS BECAUSE THE FILTER'S OWN SUITE CANNOT CATCH WHAT IT CHECKS,
AND DID NOT.** That suite tests the mechanism against a fixture that copies this service's table, so
it stayed green while the service passed **no** table at all and every duplicate email answered 500.
The mechanism being right is not the same fact as the service using it. This test reads the
migrations and fails if a column they constrain has no code bound to it.

Routing, from `events.md` §3: `aggregatetype = identity.account` → topic
`arthome.identity.account`, `aggregateid` = the account id, `type =
identity.account.registered.v1`.

**Gates, run 2026-09-25 and all clean:**

```
pnpm --filter @arthome-platform/identity exec tsc --noEmit -p tsconfig.json   # clean
pnpm --filter @arthome-platform/identity exec vitest run                      # 4 files, 24 tests
pnpm --filter @arthome-platform/identity exec prettier --write "src/**/*.ts"  # clean
pnpm --filter @arthome-platform/identity exec eslint src --max-warnings 0     # clean
```

`pnpm run verify`, `check:enums` and `check:language` were **not** run — the whole-repository gates
belong to the session that installs and commits. No `git`, no `docker`, no install.

## 2. What only this service knows

### (a) The Blocker that was live until 2026-09-25: a wrong-typed body field was committed AND published, as two different values

`POST /accounts` with `"locale": {"a":1}` passed through every hop with no error:

- **`pg` 8.23.0** — `prepareValue` (`utils.js:45-70`) sends an object to `prepareObject`, which
  ends in `JSON.stringify`. The `locale text` column stored `{"a":1}`.
- **`@bufbuild/protobuf` 2.15.0** — the writer's `string` method (`binary-encoding.js:241-245`)
  does `if (typeof value !== "string") { value = String(value); }`. The event carried
  `[object Object]`.

**The aggregate and the fact it published therefore disagreed permanently**, and
`notifications.welcome_email.locale` received the second of the two. There was no error, no log
line and no failing test: the row and the message were both well-formed, and only their contents
were wrong.

**Being text on the wire is what made this invisible, not what made it safe.** That is the exact
sentence `apps/catalog/HANDOVER.md` §2(e) got backwards, and it is worth keeping in mind for the
next field: a *wrong value* on a text field does arrive wrong and stay visible; a *wrong type* is
coerced into something plausible, by both libraries, in two different directions.

**Fixed by `register-account.schema.ts` plus a globally bound pipe.** Neither half works alone: a
schema on a `@Body()` parameter is only metadata, and `StandardSchemaValidationPipe` is what reads
it. Before this pass there was **no `APP_PIPE`, `APP_GUARD`, `APP_FILTER` or `useGlobal*` anywhere
in the repository**.

### (b) `zod` was not a dependency of this service, and the code knew

`zod` 4.6.5 was in the lockfile and in the pnpm store, but only for `libs/config` and as a resolved
peer of `@arthome/core`. It was not reachable from here — `cd apps/identity && node -e
"import('zod')"` gave `ERR_MODULE_NOT_FOUND`. `catalog.controller.ts` had said so in a comment for
as long as it existed ("needs zod, which this service does not depend on"), which is why that
service reached for `isMember` instead.

It is a dependency of both services now, **exactly pinned at `4.6.5` and not a range**. That is not
style: `@arthome/core` declares zod an exactly pinned optional peer because "two zod copies in one
process means two schema registries and unintelligible errors", and `libs/config` has a test named
"runs ONE copy of zod, not two" guarding it. A range would let a service resolve a second copy and
break `instanceof` across the boundary.

### (c) The route no longer returns the internal account id

`identity.controller.ts` returned `{ accountId }` while `account.entity.ts:30` said of that column
"UUIDv7, **never exposed**". `data-model.md` §7.1 gives the cost: a UUIDv7 reveals its own creation
instant and is orderable, so a caller holding two can order the population and date every account.

It now returns `{ publicHandle }` — the identifier a surface is given, and one the caller already
sent. The service still produces the id: it is the aggregate's identity and the partition key, and
it simply does not leave. **The comment on the entity was not touched**: it is what made the finding
confirmable, and the code is what was wrong.

### (d) The `traceparent` is validated, and a malformed one still does not fail the request

The inbound header reaches `outbox_event.tracecontext`, then a Kafka header, then
`notifications.welcome_email` — and `tracecontext` is the **one outbox column with no CHECK
constraint**, so the guards `@arthome-platform/messaging` puts on `aggregatetype`, `aggregateid`,
`type` and `payload` have no counterpart for it.

It cannot be validated by a pipe, and that is a property of NestJS rather than an omission:
`@Headers` is declared `(property?: string) => ParameterDecorator` in the installed
`@nestjs/common` 12.0.3 — no options object, therefore no `schema` for the pipe to find. So it is
parsed by hand in the controller.

**A malformed traceparent is dropped to `null`, never refused.** That was decided at
`identity.controller.ts:23-26` and is not reopened: a broken trace is an observability fault, never
a business one. Rejecting the request would reopen it; dropping it honours it. `parseTraceparent`
returns `null` rather than throwing for exactly this reason.

Only version `00` is accepted, and an all-zero trace-id or parent-id is refused — both are invalid
by the specification and both are what a half-initialised tracer emits. The cost of the version
strictness is currently nil (`00` is the only version defined), and the reason it is strictness
rather than pass-through is that the trace-id is **read** here: it is the error envelope's
`traceId`.

### (e) The duplicate-email 500 was an oracle, and is now a 409

A duplicate `email` or `public_handle` answered `{"statusCode":500,"message":"Internal server
error"}`. Three things wrong with that: the status was wrong, there was nothing for a client to
branch on, and the 500-versus-201 difference answered "is this address registered?" to anyone who
could reach the port.

`ErrorEnvelopeFilter` maps pg `23505` to a 409 with a code. **It does not say which column
collided** — that is the oracle, and `@arthome/core`'s `error-codes.ts` records the standing
exception that settles it: "`identity.*` STAYS VAGUE ON PURPOSE. An authentication refusal that says
which check failed is an oracle, and answers a question the caller was not entitled to ask."

**The constraint name is logged and the pg `detail` is not.** `QueryFailedError` copies the driver
error's properties onto itself, so its own `message` is pg's "duplicate key value violates unique
constraint …" and its `detail` is "Key (email)=(someone@example.test) already exists" — the column
**and** the person's address. One spread of `getResponse()` would have served both. The constraint
name goes to the log because that is where "which column" is useful and harmless; the address goes
nowhere, because a conflict is not a reason to copy someone's email into a log file.

### (f) The route did not ship closed, and that part was not deferred

`POST /accounts` binds on `0.0.0.0` with no guard. `adr-auth.md` defers authentication and that
decision is untouched — but "the route is reachable by anyone who can route a packet to the port" is
not deferred by anything, and critical-rules #5 forbids the argument that would excuse it: "never
'only the BFF calls me'".

`DenyInProductionGuard` is bound globally and refuses every request when `NODE_ENV` is neither
`development` nor `test`. `docs/agents/event-path.md`'s walkthrough and the test suite both still reach the handler.

Since auth slice A, the internal token's guard runs first on every route but the probes, and
`DenyInProductionGuard` behind it refuses what no slice has authorised yet; identity's slice A
routes are allowed in production.

Two things to know about it:

- **The predicate is `isProductionEnvironment` in `@arthome-platform/config`, not a comparison in
  either service.** It asks "is this one of the two reachable environments" rather than "is this
  production", and the two reasons for that agree. It is fail-closed: a `staging` added to
  `EnvSchema` is production-like until someone says otherwise, so widening the schema cannot quietly
  open a guarded route. And the literal `'production'` cannot be written in a service's `src/` at
  all — `arthome-check-enums` reports it, correctly by its own rules, because `production` is a
  member of `MEMBER_ROLES` (somebody works *in* production, the crew sense), and the single
  allow-list entry for that collision is scoped to `libs/config/src/env.ts`. Both services briefly
  carried a double-negative predicate and a paragraph explaining it; the export in `config` replaced
  both, which is where the fact belongs — `env.ts` is the one file that already reads the
  environment, once, at startup.
- **It refuses EVERY route in production, so the liveness probe this service does not yet have will
  need an exemption** — `Reflector.createDecorator` metadata read with `getAllAndOverride`. Not
  built: a decorator with no route to exempt is shape invented ahead of its use.

### (g) `transport.md` §5.5 was missing three codes — all three now exist, and no substitute ships

§5.5's status table is **pre-D-067**: written in SCREAMING_SNAKE throughout, while D-067 converted
every code to dotted lowercase. Measuring that table against the arrays `@arthome/core` actually
exports, it **promises 28 code names and 12 were emittable by nobody**. Three of the twelve blocked
this edge, and all three were published during this pass (arthome-core `63ca16a` and `60ec163`):

| §5.5 says | Status | Now |
| --- | --- | --- |
| `STATE_CONFLICT` | 409 | **no generic member, by design.** A 409 carries the code that names the specific refusal |
| `INTERNAL` | 500 | `ApiErrorCode.INTERNAL` = `api.internal` |
| `SERVICE_UNAVAILABLE` | 503 | `ApiErrorCode.SERVICE_UNAVAILABLE` = `api.service_unavailable` |

**Nothing substitutes for anything any more.** Two named constants existed briefly to hold
knowingly-wrong stand-ins (`ApiErrorCode.SCHEMA_INVALID` at 409, `ApiErrorCode.UPSTREAM_UNAVAILABLE`
at 500 and 503); both are deleted rather than repointed, because a constant whose only content is
`= ApiErrorCode.INTERNAL` is indirection naming nothing.

**`api.upstream_unavailable` MUST NOT BE EMITTED BY THIS SERVICE, and there is a test asserting no
path does.** It means "a service behind the BFF failed". Said about ourselves it is false, and it
destroyed the one distinction a caller acts on — **503 is retryable and 500 is not** — because one
substitute answered 500, 502 and 503 alike. It stays reserved for the BFF relaying a failed service.

**The 409 is per-column, and that is the contract's design rather than a preference.** The published
`Conflict` response description reads *"Definitive business refusal. The `code` says which one"*, and
18 responses share it. `account` has two `citext unique` columns, so the filter reads the constraint
name and answers `IdentityErrorCode.EMAIL_TAKEN` or `IdentityErrorCode.HANDLE_TAKEN` —
`identity.handle_taken` having been added to the domain for exactly this, rather than collapsing both
into one code that would be false half the time.

**AND THE STANDING VAGUENESS EXCEPTION DOES NOT REACH THIS.** `error-codes.ts` says an
*authentication* refusal that names which check failed is an oracle. A registration conflict is not
an authentication refusal, and the proof is internal to the vocabulary: `identity.email_taken` is
published, so if the exception covered sign-up the member would contradict the rule beside it.

**WHAT THE ORACLE ACTUALLY IS, because this was mis-sited at first — mine.** It was never the code;
it is the **status**. A 409 where a 201 would otherwise be returned tells the caller the address is
registered before any code is read, and a vaguer code cannot un-leak that. Reading the constraint to
serve the right code therefore discloses nothing the status had not already given away.

**THE OPEN QUESTION, ABOVE THIS SERVICE AND NOT DECIDED HERE: should sign-up disclose a taken
email at all?** The standard mitigation is to answer as though it had succeeded and disambiguate out
of band, by email. That is a registration-flow design decision, far larger than an error code, and
the published vocabulary is the project's current answer — so `EMAIL_TAKEN` is served today. Raised
and carried upward during this pass; **not implemented, deliberately.** If it is ever decided the
other way, this filter's per-column mapping and `identity.email_taken` itself are what change.

**Decided on 2026-10-03 (D-099): sign-up keeps answering `409` `identity.email_taken`**, the
enumeration slowed by the storefront BFF's cap per address (`AuthRateLimit.SIGN_UP_PER_ADDRESS`).
Sign-up now answers it itself, before the unique constraint is reached (§0).

Also unreconciled, and smaller:

- **Success responses carry no `servedAt`.** critical-rules #9 and §5.5 both require it, and §5.5
  also wraps the payload in `data`. Errors carry it now (through `@arthome/core`'s `Clock` port, so
  it is assertable with a `FixedClock`); `POST /accounts` still answers `{ publicHandle }` bare.
  Not changed: restructuring a success body is a contract change to an endpoint no document
  describes.
- **`traceId` is omitted, not empty, when no usable traceparent arrived.** `ErrorSchema.traceId` is
  `z.string().min(1)`, so an empty string would satisfy the field's presence and send a reader
  looking for a log line that does not exist.
- **`@arthome/core` contradicts itself about `params`.** `MessageParams` is
  `Record<string, string | number | boolean>` and refuses an array; `ErrorSchema.params` is
  `z.looseObject({})`, and `schema/error.ts` explains why — the studio contract publishes
  `{ missing: ['poster', …] }` as an example of that very field. `Refusal.params` follows the wire
  schema. Reported, not worked around.
- **An unrecognised key is refused without being named.** Measured: zod's issue for that case is
  `{ code: 'unrecognized_keys', keys: ['…'], path: [] }` — the key is in `keys`, `path` is empty, so
  `params.fields` has nothing to report, and `keys` is unreachable because `exceptionFactory` is
  typed against Standard Schema's `Issue` (only `message` and `path`).

### (h) `locale` became member-strict, which is a behaviour change

`LocaleIn` is `vocabularyIn(LOCALES)` and `LOCALES` is `['fr', 'en']`, so `"locale": "de"` was
accepted before and is refused now. That is the `In` side, where member strictness is correct:
critical-rules #10's tolerance is the `Out` rule, for a television on a year-old build, and
`vocabulary.ts` states the mirror — "tolerance on a read degrades a card; tolerance on a write
corrupts a record". A `de` account was one whose welcome email had no template.

`country` deliberately did **not** get the same treatment: `CountryCodeSchema` is `/^[A-Z]{2}$/`, so
`"ZZ"` passes. ISO 3166-1 has some 250 members and moves, `@arthome/core` publishes no vocabulary
for it, and a list written here would be a parallel table going stale inside one service.

**Every field left permissive says so, with its reason, in the schema.** An audit noted that
`@Body() body: RegisterBody` is byte-identical between "I decided this field is free-form" and "I
never considered it" — which is why D-069's per-case boundary left no trace at this edge. The point
of those comments is that the next reader can tell a decision from an omission.

### (i) Where a schema belongs, and why "DTOs live in contracts" is the wrong move here

**The line is who consumes the shape, not which repository it sits in.**

- **frontend ↔ BFF** → `@arthome/contracts` in arthome-core. Those schemas exist so the storefront
  and the studio share them instead of doing the same work twice; a browser has to have them. That is
  why the package has 15 subpaths, and why `check:emit-diff` compares all 111 of their schemas
  against the two OpenAPI documents — which are, in the README's own words, "the contracts of the two
  BFFs".
- **BFF → service** → stays in arthome-platform, permanently. `POST /accounts` and `POST /shows`
  appear in no OpenAPI document and no frontend will ever call them.

So `register-account.schema.ts` lives beside its controller and **stays there**. It is not waiting
for a BFF to be extracted into a shared package: when a BFF is written, the shape that belongs in
`@arthome/contracts` is the BFF's own **client-facing** request and response schema, because the
frontends consume that one. This service's inbound shape is not the same shape and never becomes it.

**THE MOVE THAT LOOKS OBVIOUS IS THE HARMFUL ONE.** "These are DTOs, DTOs live in contracts" would
put a service's internal input shape on a package every browser installs, and would then have
`check:emit-diff` compare it against an OpenAPI document that does not describe it. Recorded because
the reasoning is not visible from either file.

## 3. The HTTP edge is `@arthome-platform/http-edge`, and it was briefly duplicated

The filter, the guard, the refusal shape and the traceparent parser were written into
`apps/identity/src/http/` and `apps/catalog/src/http/` first, because `libs/**` was outside the
pass's trees. That is two implementations of one thing, which critical-rules #2 forbids in as many
words — "two calls are allowed, two implementations never" — so it was reported rather than left,
the lead scaffolded `libs/http-edge` in response, and the extraction was completed in the same pass.

**Why the move was safe, measured rather than hoped:** with comments stripped, the two service
copies were **byte-identical**. They were kept that way deliberately while they existed, so the diff
was empty and the move could not silently drop a branch. Verified by comparing them with comments
removed before deleting either.

The library exports `Refusal`, `UniqueViolationCode`, `RefusalException`, `isMappedStatus`,
`refusalForStatus`, `schemaInvalidRefusal`, `schemaInvalidException`, `ErrorEnvelopeFilter`,
`DenyInProductionGuard`, `parseTraceparent` and `TraceContext`, and holds 31 tests.

**WHAT STAYS IN THE SERVICE, AND WHY IT IS NOT AN EXCEPTION TO THE RULE**: the two endpoint
schemas, and `unique-violations.ts` — the table binding each uniquely-constrained column to its code.
The library knows how to *match* a constraint; only the service knows what its columns mean. Passing
an empty table is legitimate: `catalog`'s `show` has no unique constraint at all.

**BUILD THE LIBRARY ONCE OR A PER-SERVICE `vitest` RUN WILL NOT RESOLVE IT, and the error names
the wrong thing.** `pnpm --filter @arthome-platform/identity exec vitest run` invoked from the
service directory does **not** read the root `vitest.config.mjs`, so it resolves the workspace
dependency through the `default` export condition — `dist/index.js` — and reports "Failed to resolve
entry for package @arthome-platform/http-edge. The package may have incorrect main/module/exports
specified in its package.json", which sends the reader to a manifest that is fine. The root config's
own header comment describes exactly this trap for `@arthome-platform/messaging`; its fix,
`resolve.conditions: ['@arthome/source']`, is in the root suite and not in a per-service
invocation. `dist/` is gitignored and every other library has a locally built one:

```
pnpm --filter @arthome-platform/http-edge run build
```

**THE LIBRARY DEPENDS ON NEITHER `typeorm` NOR `zod`, AND MUST NOT START.** It recognises a pg
unique violation by duck-typing `code` and `driverError.code` rather than `instanceof
QueryFailedError`, so the transport layer does not depend on the ORM; and the pipe's
`exceptionFactory` types its issues structurally rather than importing zod. Both were in the first
scaffold and were removed. The next reader's instinct will be to import `QueryFailedError` for one
`instanceof` — the comment at that function says why not.

## 4. What remains

Owed, in rough order of consequence:

1. **`notifications` sends nothing.** The verification link reaches the outbox and the topic; no
   consumer turns it into an email yet, as none turns the welcome into one.
2. **Rate limiting** is the storefront BFF's (core's `AuthRateLimit`); identity has none of its own,
   and is reachable only with a BFF's token. A body-size limit is still Fastify's default.
3. **The success envelope** is served (`edgeProviders`' interceptor) on the slice A routes.
4. **`docs/agents/event-path.md`'s walkthrough** registers through the storefront BFF's sign-up now; it has not
   been run on the full stack in this pass (the container suites have).
5. **The nine other code names `transport.md` §5.5 promised** are mostly emittable now
   (`api.token_expired`, the idempotency pair, the deadline and upstream codes); `pairing.expired`
   and `api.gateway_unavailable` wait for their surfaces.
6. **Device rows grow without a bound** (PI1). Every sign-in without a device cookie, and every
   bearer sign-in, inserts a `device` row; nothing caps or reaps them. The account slice owes a
   reaper of devices with no open binding and an expired token, or a per-account cap.
7. **A bearer session gets a device whose token nobody keeps** (PI1): a native shell has no device
   carrier yet, so the BFF sends `token: null`. Harmless, it binds the session; the native slice
   replaces it with the ES256 `device_token`.
8. **`device` is optional on sign-up and sign-in** only for the window between PI1 and PB1
   merging; making it required is a one-line follow-up in `devices/presented-device.schema.ts`'s
   callers.
