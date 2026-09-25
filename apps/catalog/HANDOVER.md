# `catalog` — wave 2 handover

`POST /shows` publishes a show: one transaction, one `manager`, the business row and the
outbox row together. Mirrors `apps/identity/`'s slice. Everything below was verified by
running it, not by reading it.

## 1. What was built

| File | What it is |
| --- | --- |
| `src/catalog/show.entity.ts` | the slice of the `Show` aggregate the `ShowPublished` contract exercises |
| `src/migrations/1758800000000-initial.ts` | the `show` table, its channel index, and the outbox from `outboxTableDdl()` — guards included, in one step |
| `src/catalog/publish-show.service.ts` | the one-transaction write via `writeOutboxEvent` |
| `src/catalog/catalog.controller.ts` | `POST /shows`, 201, `cache-control: no-store` |
| `src/catalog/catalog.module.ts`, `src/app.module.ts`, `src/main.ts`, `src/data-source.ts` | the wiring, copied from identity |
| `src/catalog/publish-show.service.spec.ts` | 8 tests |
| `src/catalog/catalog.controller.spec.ts` | 7 tests — not on the deliverable list; see §2(f). **Rewritten 2026-09-25**: the two `languageDependency` cases moved to `publish-show.schema.spec.ts` with the guard, and cases for the domain media rule and the malformed traceparent were added |

**Added 2026-09-25 (the HTTP edge — §2(l)):**

| File | What it is |
| --- | --- |
| `src/catalog/publish-show.schema.ts` | the zod schema for the body: every field |
| `src/catalog/publish-show.schema.spec.ts` | 10 tests |

The shared edge — the filter, the guard, the refusal shape, the traceparent parser and their 26
tests — lives in **`libs/http-edge`** (`@arthome-platform/http-edge`), not here. §2(m).
| `.env.example` | `PORT=3002`, database `catalog` |
| `package.json` | added `migration:run` / `migration:revert`, identical to identity's |
| `src/index.ts` | **deleted** — the placeholder; nothing needed it |

Routing, from `events.md` §3: `aggregatetype = catalog.show` → topic `arthome.catalog.show`,
`aggregateid` = the show id (§3 fixes the key for this topic as `show_id`),
`type = catalog.show.published.v1`.

**Gate results, run in `apps/catalog` and all green:**

```
pnpm --filter @arthome-platform/catalog exec tsc --noEmit -p tsconfig.json   # clean
pnpm --filter @arthome-platform/catalog exec vitest run                      # 3 files, 25 tests, all pass
pnpm --filter @arthome-platform/catalog exec prettier --check "src/**/*.ts"  # clean
pnpm --filter @arthome-platform/catalog exec eslint src --max-warnings 0     # clean
pnpm run check:enums                                                         # PASS (read-only; see §2(a))
pnpm run check:language                                                      # PASS (read-only)
```

> Counts re-run 2026-09-25 after §2(l) and the §2(m) extraction: 3 files, 25 tests here, plus 26 in
> `libs/http-edge`. `check:enums` and `check:language` were
> **not** re-run in that pass — only the four per-service commands were in scope — but no new string
> literal duplicating a vocabulary was introduced, and the one that would have (`'production'`, a
> member of `MEMBER_ROLES`) was deliberately avoided; `app.module.ts` says how and why.

Nothing outside `apps/catalog/**` was written. No `git`, no `docker`, no install, no
repo-wide format or lint.

## 2. What only I know

### (a) The literal gate does not cover the routing values, and it cannot

`check:enums` passes, and I ran it rather than eyeballing the surface — it is read-only, so
it was safe to use as a self-check. But it proves less than it looks like it proves here.

`'catalog.show'` and `'catalog.show.published.v1'` are **hand-written literals with no
owning constant anywhere**. `@arthome/core` has no `AGGREGATE_TYPES` and no event-type
vocabulary — I checked all 543 exported names in `available-surface.md`. The gate matches
whole literals, so `'catalog.show'` is invisible to it even though `SERVICES` declares
`'catalog'`.

**So `events.md` §3's routing table is being copied by hand into every service, and nothing
checks it.** Identity did it, I did it, five services remain. A typo in an `aggregatetype`
does not fail a test — it either kills the connector (topic-unsafe, and the CHECK catches
that one) or silently publishes to a topic nobody consumes (topic-safe and wrong, which
nothing catches). This is E2 in the highest-consequence place left in the repository, and it
is the one finding I would act on first. The fix is a vocabulary in `@arthome/core`
generated from `events.md` §3, or a gate that reads that table.

### (b) `outboxTableDdl()` omits the index identity created by hand

`outboxTableDdl()` emits the columns and the four CHECK constraints, but **not**
`idx_outbox_event_created_at`. Identity created it in its own initial migration
(`apps/identity/src/migrations/1758700000000-initial.ts`, last statement). I created it too,
in `1758800000000-initial.ts`, so the two services match — but only because I noticed. The
next service has to notice independently.

It belongs in `libs/messaging/src/outbox.ts` beside the constraints, for exactly the reason
the file's own header gives for the constraints living there. I did not move it: outside my
tree.

### (c) `ShowPublished` carries no displayable field, and no actor

Two contract observations, from reading
`/home/julien-metral/Dev/arthome/arthome-core/proto/arthome/catalog/v1/events.proto`
(message `ShowPublished`, lines 477–554 of the generated TS):

1. **No title, no synopsis, no slug.** `data-model.md` §2.1 puts the bilingual title and
   synopsis on the aggregate and §2.7 adds `slug_fr`/`slug_en`, but the event publishes none
   of them. A consumer of `arthome.catalog.show` — `apps/search-indexer` is the first —
   therefore cannot get a displayable or linkable field out of this topic. Its options are
   to call `catalog` synchronously (forbidden, critical-rules #1) or to index a show it
   cannot render. **Worth raising with whoever owns the proto before search-indexer commits
   to a projection shape.** I modelled the entity to match the event and said so in
   `show.entity.ts`.
2. **No `Actor`.** `DateDrafted` has `drafted_by`, `DateScheduled` has `scheduled_by`,
   `PublicationStateChanged` has `changed_by` — `ShowPublished`, `ShowUpdated` and
   `ArtistUpdated` have none. So a show publication cannot be attributed on the wire at all;
   the only channel is the outbox's `actor_id` column, which the router does map to an
   `actor-id` header (`infra/debezium/identity-outbox.json`, `table.fields.additional.placement`).
   Given §2.3 keeps `last_actor_id` on the publication, the asymmetry looks unintended.

### (d) `actorId` is null, and that is a gap I chose not to paper over

I write `actorId: null`. Publishing a show is a named studio act, so the studio journal is
what goes without. I left it null because **this slice has no verified actor**: JWKS
verification (critical-rules #4) is not built here, and reading a name out of a request
header is precisely the `x-user-id` that rule forbids. An unverified name in a journal that
arbitrates thousands of euros is worse than an absent one. There is a test asserting the
null, so the day an actor exists it is clear the column was deliberate and not forgotten.

### (e) Where I diverged from identity: one validated field

> ⚠ **CORRECTED 2026-09-25 — the premise of this section was wrong, and it was wrong in the
> direction that hides a defect.** The paragraph below said identity "can afford" unvalidated
> `locale` and `country` because "they are text on the wire, so a wrong value arrives wrong and
> stays visible". That is true of a wrong **value** and it **inverts** for a wrong **type**.
> `@bufbuild/protobuf` 2.15.0's writer does
> `if (typeof value !== "string") { value = String(value); }` (`binary-encoding.js:241-245`), so
> `{"a":1}` is published as the four plausible characters `[object Object]`; `pg` 8.23.0's
> `prepareValue` (`utils.js:45-70`) sends the same object through `JSON.stringify`, so the column
> holds `{"a":1}`. The aggregate and the fact it published then disagree **permanently**, and
> `notifications.welcome_email.locale` received the second of the two. Being text on the wire is
> what made it invisible, not what made it safe. Both services now validate every inbound field;
> see §2(l).

The original text, kept because the reasoning it contains about `languageDependency` is still
right and is why that field was guarded first:

Identity lets `locale` and `country` through unvalidated, and can afford to — they are text
on the wire, so a wrong value arrives wrong and stays visible. I added **one** guard, on
`languageDependency`, in the controller:

> `languageDependency` is a Protobuf **enum**. An unknown member has no number, so the
> silent outcome is `LANGUAGE_DEPENDENCY_UNSPECIFIED` — a published fact that says nothing
> about the field the surface's most visible language rule (`hasLanguageBarrier`) reads, and
> nothing anywhere fails. That is the same class of fault the outbox's `payload_not_empty`
> CHECK exists to stop one level down, so I stopped it at the boundary, where a request is
> still waiting to be told.

Judgement calls inside that:

- **`isMember` from `@arthome/core`, not zod.** The correct `In` strictness is
  `vocabularyIn` from `@arthome/core/schema`, which needs zod — not a dependency of this
  service, and I did not add one. `isMember`'s own doc restricts it to paths where the value
  is not displayed; a write-boundary refusal qualifies.
- **Strict, not tolerant, and the direction is what decides.** critical-rules #10 keeps an
  unknown member raw and neutral — that is the `Out` rule. This is `In`.
- **`ApiErrorCode.SCHEMA_INVALID`, invented nothing.** `CATALOG_ERROR_CODES` are all
  `date.*` and none fits a malformed request field. `api.schema_invalid` is a transport
  concern about a malformed body, which is what this is — the usage that code's own doc
  comment endorses. I did **not** add a code to `@arthome/core`: that is the mistake
  identity recorded against itself with `ACCOUNT_STATUSES`.
- **The envelope is incomplete and I did not build it.** The refusal carries `code`,
  `params` and `nature`, all from `@arthome/core`. It does **not** carry `traceId`, and it is
  a bare Nest `BadRequestException` rather than `StorefrontErrorEnvelopeSchema` — which
  lives in `@arthome/contracts/envelope`, also not a dependency here. Identity has no error
  path at all, so there was nothing to mirror. **This is the one place my slice emits a
  shape that critical-rules #8 would not fully accept.**

  > **Built 2026-09-25 — §2(l).** `@arthome-platform/http-edge`'s `ErrorEnvelopeFilter` now serves
  > `transport.md` §5.5's `{ error: { code, nature, params, traceId }, servedAt }` for **every**
  > error, so the 400 and the 500 are one shape. `traceId` turned out to be buildable after all:
  > §5.5 defines it as the `trace-id` field of the `traceparent`, and the parse that item 2 added
  > for the header yields it. `StorefrontErrorEnvelopeSchema` is still not used, and still for the
  > reason given here — it is a BFF contract shape and this service does not depend on that
  > package. What §5.5 asks for that is still missing is the **success** envelope, and three codes
  > the vocabulary does not carry; both are set out in §2(l).

### (f) The `languageDependency` encoding, and why it is not a parallel literal table

`WIRE_LANGUAGE_DEPENDENCY` in `publish-show.service.ts` maps `@arthome/core`'s
`LanguageDependency` to the generated Protobuf enum. §5.2 says "a transform is the parallel
literal table wearing a codec's costume", so this needed justifying rather than just
writing:

- what §5.2 forbids is two live **spellings** with a function asserting they agree. Here
  there is one spelling — core's, which is also the wire's — and a Protobuf enum, which is a
  **number** on the wire whatever anyone prefers;
- **no literal on either side**: the keys are computed from core's named members, the values
  are protobuf-es's generated enum. Neither spelling nor number is retyped;
- `satisfies Record<LanguageDependency, …>` makes it exhaustive **in the domain direction**:
  a fourth member in `LANGUAGE_DEPENDENCIES` fails the build. The reverse is deliberately not
  checked — the proto's `UNSPECIFIED = 0` has no domain member and must not gain one.

I also added `catalog.controller.spec.ts`, which is **not** on the deliverable list. Reason:
the refusal path above is a branch I introduced, and an untested throw is a liability. Four
tests: the refusal happens, nothing reaches the transaction, the body is a code and not a
sentence, and the traceparent survives. Say so if the extra file is unwanted — the four tests
delete cleanly.

### (g) `MediaSet` needed no conversion, and that decided the command's type

`@arthome/core`'s `Rendition` and `arthome.common.v1.ImageRendition` agree field for field —
`url`, `widthPx`, `heightPx`. So `media` goes into `create()` with only a spread (readonly →
mutable), and I typed the command with core's `MediaSet` rather than a local shape
specifically so there would be nothing to map. A local shape would have manufactured a
transform.

I included `media` rather than leaving it unset on purpose: it is the one nested message on
`ShowPublished`, so it is what makes the payload round-trip test prove the nested encoding
and not just scalars.

### (h) Deliberate omissions from the entity

Each is commented in `show.entity.ts`. Summary: bilingual title/synopsis, cast and the
per-language slugs (§2.1, §2.7) are out because the event carries none of them and nothing
in the slice reads them back; `version` is out because optimistic concurrency belongs to
`Publication`'s transitions (§2.3) and a publish here is one insert with no prior state;
`attributes{}` is out (§2.6) for the same reason as the slugs.

The column is `category_id`, not `discipline`: `data-model.md` §2.1 says "discipline" and the
published contract says `category_id`. The wire wins (§5.2 — the wire is the side that is
expensive to change), and I noted the divergence in the entity so the next reader does not
"fix" it.

### (i) The table name is quoted, and that is deliberate

`CREATE TABLE "show"` — `SHOW` is a Postgres command word. It is unreserved, so the unquoted
form happens to parse today; TypeORM quotes it in every statement it generates from
`@Entity('show')`, so an unquoted migration would be the one spelling that differs. Commented
in the migration.

### (j) Outside my tree, noticed while running the gates

- **`libs/events/src/index.ts`** — the blocker below. Resolved by the lead while I worked.
- **`apps/search-indexer/src/consumer/show-consumer.ts:31`** — `pnpm run typecheck` (the root
  program) fails with `TS6133: 'ShowProjection' is declared but its value is never read`.
  That is the other agent's in-flight file, almost certainly transient. Recording it only so
  nobody attributes a red root typecheck to `catalog`: **no error in the root run came from
  `apps/catalog/**`**, and `apps/catalog`'s own typecheck is clean.
- **`libs/events/src/index.ts`** — the flat barrel. Its own subsection, §2(k): it is the one
  item here that carries an instruction for whoever reads this next.
- **`apps/notifications/src/data-source.ts`** does not call `readEnv()` while
  `apps/identity/src/data-source.ts` does. I followed identity. Cosmetic, but the two
  services disagree about where configuration is read.

### (k) The events barrel is on borrowed time — and is NOT to be worked around

`@arthome-platform/events` has a single `.` entry point that `export *`s three generated
files. That is exactly the shape that breaks the day two contexts name the same message, and
the durable answer is the one `@arthome/contracts` already applies to itself: no `.` entry
point at all, one subpath per context, so a service declares which contexts it speaks.

Two things make this more than a style note for `catalog` specifically:

- **The collision it predicts would land on this service's import first.** Catalog's
  `LanguageDependency` already collides by name with `@arthome/core`'s — a Protobuf number
  against a domain string — and `publish-show.service.ts` has to alias one of them. That is
  the near miss, one package short of being a real conflict.
- **The headroom is measured, not assumed.** Verified independently by the lead before the
  re-export was added: common exports 14 names, identity 31, catalog 34, and all three
  pairwise intersections are empty. So the barrel is safe *today* and the count is what says
  so — which, per critical-rules #15, is the only form that claim may take. It ages the moment
  a fourth context lands.

**The instruction, and it is the lead's, not mine:** the restructuring into per-context
subpaths is owned by the lead and happens after wave 2. Until then every service keeps
importing from `@arthome-platform/events` exactly as it does now. Do not pre-empt it with a
deep import, a local alias module or a second entry point — three agents on three import
conventions costs more than the one import that will have to change later.

### (l) The HTTP edge, added 2026-09-25 — validation, the error envelope, and the guard

Added in a later pass, against `nestjs-validation`, `nestjs-request-pipeline`, `nestjs-http` and
`nestjs-auth` — the skills that were not loaded when this service was first written, which is why
§2(e) got identity's validation boundary wrong and why the "do this next" in §4 was false.

| File | What it is |
| --- | --- |
| `src/catalog/publish-show.schema.ts` | the zod schema for the `POST /shows` body — **every** field, not one |
| `libs/http-edge/**` | the shared edge, extracted in the same pass — §2(m) |
| `src/app.module.ts` | `APP_PIPE`, `APP_FILTER`, `APP_GUARD` — there was no global enhancer of any kind in this repository before |

The filter, the guard, the refusal shape and the traceparent parser were written here first, then
**extracted to `@arthome-platform/http-edge`** in the same pass — see §2(m). This service imports
them; it holds no copy.

**The pipe mechanism.** `StandardSchemaValidationPipe` **does** exist in the installed
`@nestjs/common` 12.0.3 (`pipes/standard-schema-validation.pipe.d.ts`, re-exported from
`pipes/index.d.ts`). It reads `metadata.schema`, defaults `transform: true`, and takes
`exceptionFactory(issues)`. It is bound as `{ provide: APP_PIPE, useValue: … }`.
`@Body({ schema })` is real too — `Body(options: ParameterDecoratorOptions)` with
`schema?: StandardSchemaV1`. **A schema alone validates nothing**: it is metadata, and the pipe is
what reads it, so the two halves are useless apart.

**`@Headers` genuinely cannot be validated by a pipe**, confirmed in the same package: it is
declared `Headers: (property?: string) => ParameterDecorator` — no options object, therefore no
`schema`. The `traceparent` is parsed by hand in the controller, and a malformed one is dropped to
`null` rather than refused, which is the decision `catalog.controller.ts` recorded and this keeps.

**The `languageDependency` guard moved rather than disappeared.** §2(e) said the right form was
`vocabularyIn` from `@arthome/core/schema` and that zod was not a dependency. zod 4.6.5 is a
dependency of this service now, so the schema carries `vocabularyIn(LANGUAGE_DEPENDENCIES)` and
the controller's `isMember` check is gone. The reasoning in §2(e) about *why* that field is
guarded is unchanged and still the sharpest case on this endpoint.

**Judgement calls, each of which could have gone the other way:**

- **`z.strictObject`, so an unknown field is refused rather than stripped.** This is an internal
  service endpoint with no tolerant public client, and `nestjs-validation`'s Decide table puts
  strictness there. A stripping schema would accept `genreids` silently.
- **`channelId` and `artistId` are `z.string().min(1)`, NOT `ChannelIdSchema`/`ArtistIdSchema`.**
  Both are published and both are UUIDv7 — but the columns are `text`, nothing in this repository
  fixes the format for this endpoint, and the fixtures in use are `channel-1`/`artist-1`. Pinning
  UUIDv7 would refuse, on a guess, bodies that work today. **This is the line to change if channel
  ids really are UUIDv7 on this route** — it is a one-word edit and a fixture update.
- **`categoryId`, `genreIds` and `tagIds` are `SlugSchema`.** Checked against core's own taxonomy
  data rather than assumed: `music`, `stage`, `jazz`, `theatre`, `contemporary`,
  `ballet-classique`, `open-air` all match it. This is **shape** strictness; membership in the
  taxonomy is deliberately NOT checked, because the taxonomy is data that gains and loses members
  and a list of them here would be a parallel table going stale (critical-rules #10).
- **`spokenLanguages` is `z.string().min(1)`, NOT `LocaleIn`.** `show.entity.ts` separates the two
  in as many words — this is what is PERFORMED, "unrelated to the display locale (`LOCALES`)" —
  and `LOCALES` has two members, so `LocaleIn` would refuse a show performed in German.
  `@arthome/core` publishes no BCP 47 primitive and inventing a language-tag regex in a service is
  what `available-surface.md` opens by asking nobody to do.
- **`media` is checked for shape here and for its RULE by `@arthome/core`'s `rendition()`.** That
  function already refuses an empty url (`media.url_empty`) and a non-integer or non-positive
  dimension (`media.size_invalid`), both published codes. Putting `.url()` and `.positive()` in the
  schema as well would be a second implementation of a rule the domain owns — critical-rules #2
  allows two calls and never two implementations. The cost, accepted: `rendition()` throws on the
  first bad image, so a body with two is told about one. Before this, `body.media` was passed
  straight through as a `MediaSet` with nothing having checked it.
- **`runtimeMin` is bounded by `2 ** 32 - 1`, written as arithmetic.** A wire limit, not a domain
  constant, so it is declared locally rather than referenced from an owning document
  (critical-rules #15). It turns the rollback-and-500 described in the §4 correction into a 400.
- **Deliberately permissive fields are marked as such.** An audit noted that `@Body() body:
  RegisterBody` is byte-identical between "I decided this field is free-form" and "I never
  considered it". Every field above that is shape-only rather than member-strict says so in the
  schema with the reason, so the next reader can tell a decision from an omission.

**What I could not reconcile with `transport.md` §5.5 — three codes it names that the vocabulary
does not carry.** §5.5's status table is **pre-D-067**: it is written in SCREAMING_SNAKE
throughout, and D-067 converted every code to dotted lowercase. Three of its entries have no
surviving member anywhere in `@arthome/core`:

| §5.5 says | Status | Reality |
| --- | --- | --- |
| `STATE_CONFLICT` | 409 | no member. The only "already in use" code is `identity.email_taken`, which names a column |
| `INTERNAL` | 500 | no member |
| `SERVICE_UNAVAILABLE` | 503 | no member |

The filter serves `ApiErrorCode.SCHEMA_INVALID` at 409 and `ApiErrorCode.UPSTREAM_UNAVAILABLE` at
500/503, each behind a single named constant in `@arthome-platform/http-edge`'s `refusal.ts`
with the full reasoning at the
declaration. **Both are substitutes and both are wrong in a stated way** — the 409's code collides
with the 400's, so a client tells them apart by status only. The fix is one member in
`API_ERROR_CODES`, `api.conflict`, plus one for the internal case, and it belongs in
`@arthome/core`. Those are the two lines to change here.

Two smaller unreconciled points:

- **Success responses still carry no `servedAt`.** critical-rules #9 and §5.5 both require it, and
  §5.5 also wraps the payload in `data`. Errors now carry it; `POST /shows` still answers
  `{ showId }` bare. Not changed, because restructuring a success body is a contract change to an
  endpoint no document describes, and it was outside this task. It is owed.
- **An unrecognised key is refused without being named.** Measured: zod's issue for that case is
  `{ code: 'unrecognized_keys', keys: ['…'], path: [] }` — the key is in `keys` and `path` is
  **empty**, so `params.fields` has nothing to report. `keys` is not reachable, because
  `exceptionFactory` is typed against Standard Schema's `Issue`, which declares only `message` and
  `path`. The refusal is correct; only "which key" is missing, and it is missing for every
  Standard Schema validator.

### (m) The HTTP edge is a library, `@arthome-platform/http-edge` — and it was briefly duplicated

The filter, the guard, the refusal shape and the traceparent parser were written into
`apps/identity/src/http/` and `apps/catalog/src/http/` first, because `libs/**` was outside the
pass's trees. That is two implementations of one thing, which critical-rules #2 forbids in as many
words — "two calls are allowed, two implementations never" — so it was reported rather than left,
and the lead scaffolded `libs/http-edge` in response. The extraction was then completed in the same
pass.

**Why the move was safe, measured rather than hoped:** with comments stripped, the two service
copies were **byte-identical**. They were kept that way deliberately while they existed, so the
diff was empty and the move could not silently drop a branch. Verified by comparing them with
comments removed before deleting either.

`@arthome-platform/http-edge` exports `Refusal`, `RefusalException`, `CONFLICT_CODE`,
`INTERNAL_CODE`, `conflictRefusal`, `refusalForStatus`, `schemaInvalidRefusal`,
`schemaInvalidException`, `ErrorEnvelopeFilter`, `DenyInProductionGuard`, `parseTraceparent` and
`TraceContext`. Its three spec files hold 26 tests.

⚠ **THE LIBRARY MUST BE BUILT ONCE BEFORE A PER-SERVICE `vitest` RUN WILL RESOLVE IT**, and the
failure names the wrong thing. `pnpm --filter @arthome-platform/catalog exec vitest run` invoked from
the service directory does **not** read the root `vitest.config.mjs`, so it resolves the workspace
dependency through the `default` export condition — `dist/index.js` — and reports "Failed to resolve
entry for package @arthome-platform/http-edge. The package may have incorrect main/module/exports
specified in its package.json", which sends the reader to a manifest that is fine. The root config's
own header comment describes exactly this trap for `@arthome-platform/messaging`; the fix there is
`resolve.conditions: ['@arthome/source']`, which the root suite has and a per-service invocation does
not. `dist/` is gitignored and every other library has a locally built one, so:
`pnpm --filter @arthome-platform/http-edge run build`.

⚠ **Two dependencies in `libs/http-edge/package.json` are not used**, and I could not edit that
file: `typeorm` (the filter recognises a pg unique violation by duck-typing `code` and
`driverError.code` rather than importing `QueryFailedError` — deliberately, so the transport layer
does not depend on the ORM) and `zod` (the pipe's `exceptionFactory` lives there but types its
issues structurally rather than importing zod).

## 3. Blockers

**One, and it was resolved during the work.** `ShowPublishedSchema` was unreachable:
`libs/events/src/index.ts` re-exported only `common` and `identity`, while the generated code
was already present in `libs/events/src/gen/arthome/catalog/v1/events_pb.ts`. Verified with

```
cd apps/catalog && node -e "import('@arthome-platform/events').then(m=>console.log(Object.keys(m).filter(k=>/Show/.test(k))))"
```

which printed nothing. That file is outside my tree, so **I did not touch it**; I reported it
to the lead with the exact one-line fix and built the whole slice against the real import in
the meantime, with a marked TODO at that import and nowhere else. The lead added
`export * from './gen/arthome/catalog/v1/events_pb.js';` and rebuilt the package. I then
**removed the TODO** — a stale blocker note is worse than none — and re-ran every gate. The
same check now prints `ShowPublishedSchema ShowUpdatedSchema`, 59 runtime exports.

No other blocker. I never needed a shim, and no hand-written copy of a generated descriptor
exists anywhere in this tree.

## 4. What I did NOT do, and what remains

**Not verified against a running stack.** I ran no `docker`, no migration and no connector —
forbidden, and correctly so. So: the migration has **never been executed**, the `show` table
has never existed, and no `ShowPublished` message has ever reached Kafka. Everything in §1 is
proven by typecheck and unit tests only. The end-to-end proof identity has in `AGENTS.md` is
still owed for `catalog`.

**Needed outside `apps/catalog/**` before the path can run** (I changed none of it):

1. **`infra/debezium/catalog-outbox.json`** does not exist. Copy `identity-outbox.json` and
   change `database.dbname`, `topic.prefix`, `slot.name` and `publication.name` to `catalog` /
   `arthome_catalog_outbox`. Without it nothing leaves the outbox.
2. **`AGENTS.md`'s "Running the event path"** lists `migration:run` for `identity` and
   `notifications` only; `catalog` needs adding, and the `catalog` database already exists
   (`infra/postgres/init-databases.sql`).
3. **Nothing else.** `arthome.catalog.show` is already in `infra/kafka/topics.json` at 3
   partitions, matching `events.md` §3, and `compose.yaml` needs no change.

**Owed inside this service, and deliberately not built:**

- ~~**No `ValidationPipe`, no DTO, no `@arthome/contracts` schema.**~~ **DONE — see §2(l).**

  > ⚠ **CORRECTED 2026-09-25 — the "do this next" in this bullet was false, and a wrong
  > instruction costs more than a silence because it gets carried out.** It read: "`runtimeMin`
  > is the one I would do next: it is `uint32` on the wire, so a negative value does not fail —
  > it encodes as a large positive number."
  >
  > It does fail. On the installed `@bufbuild/protobuf` 2.15.0, `assertUInt32`
  > (`binary-encoding.js:692-702`) throws on a negative, on a non-integer **and** on a
  > non-number, and `toBinary` runs **inside** the transaction (`publish-show.service.ts:154`),
  > so `runtimeMin: -1` rolls back and publishes nothing — a 500 for a bad request, which is the
  > wrong status but not a corrupt record.
  >
  > **The numeric fields were accidentally guarded; the STRING fields were the unguarded ones**
  > — the exact inverse of what this bullet directed attention to. `genreIds: "abc"` was the real
  > defect: the service spreads that value twice, once into the event and once into the row, and
  > spreading a string yields its characters, so three genre ids nobody sent were committed,
  > published in `ShowPublished.genre_ids`, and indexed.
  >
  > The bullet's closing sentence was also reopened and decided the other way: the project owner
  > ruled that the schema is **zod** and lives **in the service, beside its controller** — not in
  > `@arthome/contracts/catalog`. Those documents are the two BFFs' contracts, and `POST /shows`
  > appears in no OpenAPI document, so a schema there would be contract for a consumer that does
  > not exist (`nestjs-monorepo` rule 6). When a BFF exists, both it and this service live in this
  > repository and the shared shape can be extracted then.
- **No authentication and no authorisation.** critical-rules #4 and #5 both apply to
  `POST /shows` and neither is implemented — as in identity. Anyone who can reach the port
  can publish a show for any channel.

  **Partly addressed, and only the part that was not deferred.** `adr-auth.md` defers
  authentication and that is untouched. What was fixed is that the route no longer ships
  *reachable*: `DenyInProductionGuard` is bound globally and refuses every request when
  `NODE_ENV` is neither `development` nor `test`. critical-rules #5 forbids the "only the BFF
  calls me" argument, and this is what forces the question to be answered rather than assumed.
  See §2(l).
- **No idempotency key.** critical-rules #12. A retried `POST /shows` publishes a second
  show with a second id.
- ~~**No error envelope.**~~ **DONE — `@arthome-platform/http-edge`, §2(l) and §2(m).** It now
  carries `traceId` too, which §2(e) recorded as owed: the same parse that validates the inbound
  `traceparent` yields the 32-hex trace-id `transport.md` §5.5 defines it as.
- **No consumer.** `catalog` produces only. The retry and DLQ topics
  `arthome.catalog.retry` / `arthome.catalog.dlq` exist in `topics.json` and nothing uses
  them yet.
- **Only `ShowPublished`.** `DateDrafted`, `DateScheduled`, `PublicationStateChanged`,
  `DateOutcomeDeclared` and the rest of `events.proto` are untouched, and `Date`,
  `Publication`, `Venue`, `Artist`, `Taxonomy` and `SavedSearch` have no entity. The
  `Publication` state machine (§2.3) is the substantial piece of `catalog` and none of it
  exists.
