# `identity` — handover

`POST /accounts` registers an account: one transaction, one `manager`, the business row and the
outbox row together, and the inbound `traceparent` injected at write time.

> ⚠ **THIS FILE DID NOT EXIST UNTIL 2026-09-25, AND ITS ABSENCE WAS ITSELF A DEFECT.** `catalog`
> wrote a handover and `identity` did not, so identity's debt was recorded nowhere — and the one
> place it *was* described, `apps/catalog/HANDOVER.md` §2(e), described it **second-hand and got it
> wrong**: it said identity could "afford" unvalidated `locale` and `country` because a wrong value
> on the wire "stays visible". That inverts for a wrong *type*, and the inversion was live. A
> service that documents nothing is a service whose gaps get described by someone who did not write
> it.
>
> Sections 1–2 below are reconstructed from the code by the author of the HTTP-edge pass, not by
> this service's original author. Where that distinction matters it is stated.

## 1. What is here

| File | What it is |
| --- | --- |
| `src/identity/account.entity.ts` | the slice of the `Account` aggregate wave 1 needs — and a recorded finding that the domain is missing `ACCOUNT_STATUSES` |
| `src/migrations/1758700000000-initial.ts` | the `account` table, `citext`, and the outbox |
| `src/migrations/1758700200000-outbox-guards.ts` | the outbox CHECK constraints |
| `src/identity/register-account.service.ts` | the one-transaction write via `writeOutboxEvent` |
| `src/identity/identity.controller.ts` | `POST /accounts`, 201, `cache-control: no-store` |
| `src/identity/register-account.schema.ts` | the zod schema for the body (added 2026-09-25) |
| `src/app.module.ts` | `APP_PIPE`, `APP_FILTER`, `APP_GUARD` |
| `src/identity/identity.module.ts`, `src/main.ts`, `src/data-source.ts` | the wiring |

The shared HTTP edge — the exception filter, the production guard, the refusal shape and the
traceparent parser — is **`@arthome-platform/http-edge`** (`libs/http-edge`), not a file in this
service. §3.

Tests: 3 files, 22 tests here — `register-account.service.spec.ts` (6),
`identity.controller.spec.ts` (6, new), `register-account.schema.spec.ts` (10, new) — plus 26 in
`libs/http-edge` (`error-envelope.filter.spec.ts` 16, `traceparent.spec.ts` 7,
`deny-in-production.guard.spec.ts` 3).

Routing, from `events.md` §3: `aggregatetype = identity.account` → topic
`arthome.identity.account`, `aggregateid` = the account id, `type =
identity.account.registered.v1`.

**Gates, run 2026-09-25 and all clean:**

```
pnpm --filter @arthome-platform/identity exec tsc --noEmit -p tsconfig.json   # clean
pnpm --filter @arthome-platform/identity exec vitest run                      # 3 files, 22 tests
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

⚠ **Being text on the wire is what made this invisible, not what made it safe.** That is the exact
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

⚠ **A malformed traceparent is dropped to `null`, never refused.** That was decided at
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

⚠ **The constraint name is logged and the pg `detail` is not.** `QueryFailedError` copies the driver
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
`development` nor `test`. `AGENTS.md`'s walkthrough and the test suite both still reach the handler.

Two things to know about it:

- **It asks "is this one of the two reachable environments" rather than "is this production",** and
  the two reasons agree. It is fail-closed, so a `staging` added to `EnvSchema` is refused rather
  than opened. And the literal `'production'` cannot be written in a service's `src/`:
  `arthome-check-enums` reports it, correctly by its own rules, because `production` is a member of
  `MEMBER_ROLES` — somebody works *in* production, the crew sense — and the one allow-list entry for
  that collision is scoped to `libs/config/src/env.ts`. **The clean fix is
  `@arthome-platform/config` exporting an `isProduction`**, which would remove the literal, the
  comment and the double negative. `libs/**` was outside this pass.
- **It refuses EVERY route in production, so the liveness probe this service does not yet have will
  need an exemption** — `Reflector.createDecorator` metadata read with `getAllAndOverride`. Not
  built: a decorator with no route to exempt is shape invented ahead of its use.

### (g) What could not be reconciled with `transport.md` §5.5 — three codes it names that the vocabulary does not carry

§5.5's status table is **pre-D-067**: it is written in SCREAMING_SNAKE throughout, and D-067
converted every code to dotted lowercase. Three entries have no surviving member in `@arthome/core`:

| §5.5 says | Status | Reality |
| --- | --- | --- |
| `STATE_CONFLICT` | 409 | no member. The only "already in use" code is `identity.email_taken`, which names a column |
| `INTERNAL` | 500 | no member |
| `SERVICE_UNAVAILABLE` | 503 | no member |

The filter serves `ApiErrorCode.SCHEMA_INVALID` at 409 and `ApiErrorCode.UPSTREAM_UNAVAILABLE` at
500/503, each behind a single named constant in `@arthome-platform/http-edge`'s `refusal.ts`
(`CONFLICT_CODE`, `INTERNAL_CODE`) with
the full reasoning at the declaration. **Both are substitutes and both are wrong in a stated way**:
the 409's code collides with the 400's, so a client tells them apart by status alone, and a genuine
defect in this service wears "upstream unavailable". Inventing members was rejected — a code no
contract publishes is one no surface can translate, and `account.entity.ts` records that exact
mistake against itself with `ACCOUNT_STATUSES`.

**The fix is two members in `API_ERROR_CODES`** — `api.conflict` and something for the internal case
— in `@arthome/core`. Until then those two constants are the only lines to change.

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

⚠ **Every field left permissive says so, with its reason, in the schema.** An audit noted that
`@Body() body: RegisterBody` is byte-identical between "I decided this field is free-form" and "I
never considered it" — which is why D-069's per-case boundary left no trace at this edge. The point
of those comments is that the next reader can tell a decision from an omission.

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

The library exports `Refusal`, `RefusalException`, `CONFLICT_CODE`, `INTERNAL_CODE`,
`conflictRefusal`, `refusalForStatus`, `schemaInvalidRefusal`, `schemaInvalidException`,
`ErrorEnvelopeFilter`, `DenyInProductionGuard`, `parseTraceparent` and `TraceContext`, and holds 26
tests.

⚠ **BUILD THE LIBRARY ONCE OR A PER-SERVICE `vitest` RUN WILL NOT RESOLVE IT, and the error names
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

⚠ **Two dependencies in `libs/http-edge/package.json` are unused**, and that file was outside the
pass's trees: `typeorm` (the filter recognises a pg unique violation by duck-typing `code` and
`driverError.code` rather than importing `QueryFailedError` — deliberately, so the transport layer
does not depend on the ORM) and `zod` (the pipe's `exceptionFactory` lives there but types its
issues structurally rather than importing zod).

## 4. What remains

**Never verified against a running stack by this pass.** No `docker`, no migration, no connector.
`AGENTS.md`'s walkthrough is the end-to-end proof, and it was last exercised before these changes.
Two things in it to re-check when it is next run: the response body of `POST /accounts` is now
`{"publicHandle":"@marie.j"}` rather than `{"accountId":"…"}`, and a request whose `traceparent`
is malformed now writes `NULL` to `tracecontext` instead of the malformed string — which Debezium
renders as the four characters `null`, as the walkthrough's own table notes.

Owed, in rough order of consequence:

1. **`api.conflict` and an internal code in `@arthome/core`.** §2(g). Two lines, and they retire two
   knowingly-wrong substitutes. **The largest single item now that `libs/http-edge` exists.**
2. **The success envelope.** `servedAt`, `validUntil` where applicable, and §5.5's `data` wrapper.
   Both services answer a bare object today.
3. **Authentication and authorisation.** critical-rules #4 and #5. `DenyInProductionGuard` is a
   stop-gap that makes the absence loud, not a substitute.
4. **Idempotency.** critical-rules #12: a replayed `POST /accounts` does not return the original
   response — it hits the unique constraint and now answers 409 rather than 500, which is better and
   is still not what #12 asks for.
5. **`@arthome-platform/config` should export `isProduction`.** §2(f).
6. **A liveness probe, and the metadata exemption the global guard will need for it.** §2(f).
7. **Rate limiting and a body-size limit.** Neither service has either; a body with a million
   `genreIds` is accepted by the schema. `nestjs-web-security` owns both.
8. **`ACCOUNT_STATUSES` is missing from the domain.** Recorded by `account.entity.ts` itself, not by
   this pass, and still true.
