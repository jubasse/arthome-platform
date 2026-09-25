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
| `src/catalog/catalog.controller.spec.ts` | 4 tests — not on the deliverable list; see §2(f) |
| `.env.example` | `PORT=3002`, database `catalog` |
| `package.json` | added `migration:run` / `migration:revert`, identical to identity's |
| `src/index.ts` | **deleted** — the placeholder; nothing needed it |

Routing, from `events.md` §3: `aggregatetype = catalog.show` → topic `arthome.catalog.show`,
`aggregateid` = the show id (§3 fixes the key for this topic as `show_id`),
`type = catalog.show.published.v1`.

**Gate results, run in `apps/catalog` and all green:**

```
pnpm --filter @arthome-platform/catalog exec tsc --noEmit -p tsconfig.json   # clean
pnpm --filter @arthome-platform/catalog exec vitest run                      # 2 files, 12 tests, all pass
pnpm --filter @arthome-platform/catalog exec prettier --check "src/**/*.ts"  # clean
pnpm --filter @arthome-platform/catalog exec eslint src --max-warnings 0     # clean
pnpm run check:enums                                                         # PASS (read-only; see §2(a))
pnpm run check:language                                                      # PASS (read-only)
```

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

- **No `ValidationPipe`, no DTO, no `@arthome/contracts` schema.** Only
  `languageDependency` is checked (§2(e)). `runtimeMin` is the one I would do next: it is
  `uint32` on the wire, so a negative value does not fail — it encodes as a large positive
  number. Less silent than the enum, which is why I left it, but still wrong. The right fix
  is a `ShowPublishIn` schema in `@arthome/contracts/catalog`, not more guards here.
- **No authentication and no authorisation.** critical-rules #4 and #5 both apply to
  `POST /shows` and neither is implemented — as in identity. Anyone who can reach the port
  can publish a show for any channel.
- **No idempotency key.** critical-rules #12. A retried `POST /shows` publishes a second
  show with a second id.
- **No error envelope.** See §2(e).
- **No consumer.** `catalog` produces only. The retry and DLQ topics
  `arthome.catalog.retry` / `arthome.catalog.dlq` exist in `topics.json` and nothing uses
  them yet.
- **Only `ShowPublished`.** `DateDrafted`, `DateScheduled`, `PublicationStateChanged`,
  `DateOutcomeDeclared` and the rest of `events.proto` are untouched, and `Date`,
  `Publication`, `Venue`, `Artist`, `Taxonomy` and `SavedSearch` have no entity. The
  `Publication` state machine (§2.3) is the substantial piece of `catalog` and none of it
  exists.
