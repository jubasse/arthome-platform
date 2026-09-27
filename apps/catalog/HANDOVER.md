# `catalog` — wave 2 handover

`POST /shows` publishes a show: one transaction, one `manager`, the business row and the outbox row
together. Mirrors `apps/identity/`'s slice. Everything below was verified by running it, not by
reading it.

## 0. The search read, `GET /v1/search` (2026-09-26)

`src/search/` serves the storefront's search from `arthome-catalog-date`, the index `search-indexer`
writes; catalog owns the index and its read models (`context-map.md`), and nobody calls the indexer.
The shapes served are `@arthome/contracts`': `ShowGroup`, `Facet`, the storefront `CursorPageInfo`,
at the envelope's root beside `servedAt` and `validUntil` (`CollectionResponse`).

- **One group per show** through OpenSearch `collapse`: the representative date is the first under
  the sort, and `matchingDatesCount` counts the dates the filters kept (`inner_hits`, size 0).
- **`displayState` is `publicDisplayStateOf`'s** (arthome-core D-072): a date under technical check
  shows on the time axis. Run state is passed as unknown, since `streaming` does not publish; the
  outcome is the index document's (§0c).
- **A date fully over is not served**: `over_at` (`replayEndsAt`, or `endsAt` without a replay) must
  be after now, or the card would be `ended` with no `displayStateValidUntil`, which a `DateCard`
  requires. `lives` and `replays` split at `ends_at`.
- **The cursor is an offset**, not D-010's `(created_at, id)`: OpenSearch 2.18 refuses `collapse`
  with `search_after` whatever the sort (measured on the local cluster). It expires after 24 h (410
  `api.cursor_too_old`) and never points past `max_result_window`.
- **Refused by name, never ignored**: the `artists` tab, the `popularity` and price sorts, and the
  criteria the index cannot answer (`cityIds`, `displayStates`, prices, `almostSoldOut`,
  `onPromotion`, `accessibility`) answer 400 `api.schema_invalid` with `fields`.
- **`x-arthome-deadline` is required** (transport.md §5.3): absent, 400; past, 504
  `api.deadline_exceeded` before the query; the time left bounds the OpenSearch request, and the
  query is aborted when the caller hangs up (`whenCallerLeaves`, from the response's `close`), both
  carried by the `SearchCatalog` query (§0f).
- **The title is in its own language**, the slug and canonical URL in none (arthome-core D-075): the
  contract gives this read no viewer language, and an anonymous body must be the same for every
  caller.
- Readiness does not check OpenSearch (`nestjs-search`): the index down fails the search, 503
  `api.service_unavailable`, not the service.
- The route is `/v1/search` as transport.md §5.1 shapes a service path. The older routes (`/shows`,
  `/venues`, `/channels/…`, `/dates/…`) predate that reading and have no version segment.
- Proven in `src/search/search.itest.ts` against a real OpenSearch, through the HTTP edge.

## 0b. The public date page and link resolution (2026-09-27)

`src/public/` serves `GET /v1/dates/:dateId` (`DateDetail`) and `GET /v1/resolve`
(`resolvePublicLink`), both behind the storefront BFF, both requiring `x-arthome-deadline`.

- **`date_detail_public`** is data-model.md §4's read model: one row per public date, its show and
  venue copied in, written by catalog's own commands **in their transaction** — publishing inserts
  the row (`projectDateEvents`), every transition moves its state, a show update rewrites its copy
  on every public date of the show. It carries a `version` and `applied_at`. The migration that
  creates it backfills every date already published (a date has a slug exactly once it is), and an
  integration case proves the rebuild matches.
- **The page is one query**: the date's row and its show's other rows. `seriesDates` lists the
  show's other dates not yet fully over, soonest first, ten at most, and `totalSeriesDates` counts
  them all. The synopsis is served in the title's language, or the other one when that side is
  empty. Prices, cast, chapters, suggestions and the shop wait for the services that own them.
- **A date fully over or with an outcome keeps its page**: `displayStateValidUntil` is `null` there
  (arthome-core D-073), so a link shared the day after still opens.
- **`resolve`** reads every form of §0e, a live slug first and then a replaced one, and answers the
  current canonical URL: with the date's card, the artist's summary, or nothing more for a show (the
  contract has no show summary). A URL from another origin, another kind of page, or an unknown slug
  answers 404 `api.not_found`; `kind=date` takes `{show-slug}/{date-slug}`; `kind=category` answers
  400 naming `kind`; `url` with `kind` or `slug` answers 400 naming them.
- The card is built by one function for both reads, `src/public/date-card.ts`, from a `PublicDate`
  the index document and the read-model row each map to.
- `DateDetailSchema`'s declared type in `@arthome/contracts` widens the page's own fields
  (`z.ZodObject<z.ZodRawShape>`), so `seriesDates` reads as `{}` in TypeScript; the wire is right,
  the static type is not.

## 0c. A date's outcome, `POST /v1/dates/:dateId/outcome` (2026-09-27)

The studio's `decideDateOutcome`: `postponed`, `cancelled` or `interrupted`, with the run desk's
message in the language it was written in, an `Idempotency-Key`, and `expectedVersion`.

- **`expectedVersion` is the publication's**, the only version the studio's sheet serves, and
  declaring an outcome bumps it: a screen that did not see the outcome is stale like any other (409
  `state.conflict` with the current state and version).
- **When each outcome fits is core's** (`assertOutcomeDeclarable`, arthome-core D-076), on a public
  date: `postponed` before the show and to a later instant, up to three times; `interrupted` once it
  started; `cancelled` until it ends, a postponed date included. A cancellation or an interruption
  is final. A refusal is 409 `state.conflict` naming what decided it (`outcome`, `state` or
  `startsAt`), or `date.postponement_limit_reached` with `max`. `rescheduledTo` is required for
  `postponed` and refused otherwise (400).
- **A postponement moves the date** (arthome-core D-074): `starts_at` becomes `rescheduled_to` and
  `postponements` counts it in the same transaction, the slug moves to the new day (§0e), and
  `DateRescheduled` follows `DateOutcomeDeclared` on the date's key with the new slug and URL.
  `displayState` shows `postponed` until the room opens at the new time, then the time axis again.
- `date_detail_public` takes the outcome and the new start in the same transaction; the page and the
  search cards show `outcome` and `rescheduledTo`.
- **Not served**: `moneyEffectCode` and `affectedSeats`, which are ticketing's to compute.

## 0d. The artist, the channel's public face (2026-09-27)

`PATCH /v1/channels/:channelId/identity`, the studio's `updateChannelIdentity`, writes `Artist`, 1:1
with the channel (data-model.md §2.4); `GET /v1/artists/:artistId` serves its public page.

- **`expectedVersion: 0` creates the face**, on a channel that has none, and needs `publicName` and
  `categoryId`; every later edit names the version it read (409 `state.conflict`). The answer
  carries `version` at the envelope's root (`runIdempotentlyVersioned`).
- **The slug** is the one sent, or the name's, or the name's with the artist's id when another
  artist holds it. A slug sent and held elsewhere is 409 `artist.slug_taken`; the unique index
  `artist_slug` is the backstop, mapped by `src/unique-violations.ts`. A replaced slug keeps leading
  to the artist for 30 days, and no other artist may take it meanwhile (§0e).
- **`ArtistUpdated`** carries the whole face on `arthome.catalog.artist`, keyed by `artist_id`.
- **A card names its channel's artist**: `date_detail_public.artist_id` and `artist_name` take the
  face when it exists (at publication, and on every edit for all the channel's dates), else the
  show's `artist_id` and no name, so no `artist` on the card. The search index does the same through
  `search-indexer`, and a search matches the artist's name.
- **The page** is the artist and its channel's public dates, two reads and no join: upcoming
  (scheduled to live, and postponed) soonest first, replays soonest to expire first, over (ended,
  cancelled, interrupted) latest first, twenty each. The biography is served in French when it has
  French or no copy, else in English: a URL carries no language.
- **`resolve` reads `/artist/{slug}` and `/a/{slug}`** and `kind=artist`, and answers the artist's
  summary and canonical URL.
- **Not served**: `avatarAssetId` (accepted only as null: no asset service), `country`, `verified`,
  the media, `followers` and `isLiveNow`, the shop. The **artists tab of the search and the
  directory** (`listArtists`) wait for an artist index.

## 0e. Public URLs and slugs (2026-09-27, arthome-core D-075, D-076)

- **The shapes** (`src/public/links.ts`): `/show/{show-slug}`, short `/s/{show-slug}`;
  `/show/{show-slug}/date/{date-slug}`; `/artist/{artist-slug}`, short `/a/{artist-slug}`. No
  language, two levels at most, on `PUBLIC_WEB_ORIGIN`.
- **A show's slug** is its title's (the French one when it has any), else the title's with the
  show's id tail; set at publication, in `ShowPublished.slug`, unique (`show_slug`). Two shows of
  one title published at once both find it free: the second is refused 409 `state.conflict`, and its
  retry takes the id-tailed slug.
- **A date's slug** is its day at the venue (`2026-12-15`), then `2026-12-15-2000` for a second
  performance that day, then the day with the date's id tail; unique within its show
  (`date_show_slug`); set at publication, moved by a postponement, picked under the show's row lock
  (§0f).
- **`public_slug_alias`** keeps a replaced slug (a date's, an artist's) leading to its page for
  `SLUG_REDIRECT_DAYS` (30), keyed by kind, scope (the show for a date) and slug. While it does, no
  other page may take the slug; the page itself may take it back.
- **The migration** (`PublicSlugs1790420900000`) slugs existing shows and dates with the commands'
  own functions, then writes one `DateScheduled` per published date so the index takes the new URLs;
  `search-indexer` runs its own migration first. The per-language URLs, never served outside
  development, are not carried over.
- **Known gap**: expired aliases are never purged. Each read filters on `expires_at`, so they only
  take room.

## 0f. Commands, queries and aggregates — the conventions (2026-09-27)

`context-map.md` §12 makes the publication, the date and its outcome full CQRS; event sourcing is
refused. The reference is `POST /v1/dates/:dateId/outcome` (`DeclareOutcome`) and the studio's sheet
`GET /dates/:dateId` (`GetDateSheet`). Every catalog route and the checklist consumer run this way:
no service is left. The integration suites assert what they did before the migration, and
`*.http.itest.ts` prove each module's wiring over HTTP; the behaviours changed on purpose are under
"Decided here".

**Files**, flat in the feature directory, role suffix (code-conventions §6.5):

| File                                                   | Holds                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `declare-outcome.command.ts`                           | `DeclareOutcome extends Command<R>`: route params, validated body, `traceparent`, `idempotency`           |
| `declare-outcome.handler.ts`                           | `@CommandHandler(DeclareOutcome) DeclareOutcomeHandler`                                                   |
| `get-date-sheet.query.ts`, `get-date-sheet.handler.ts` | `GetDateSheet extends Query<R>`, its `@QueryHandler`                                                      |
| `performance-date.aggregate.ts`                        | `PerformanceDate extends AggregateRoot<PerformanceDateEvent>`, owning its `Publication`                   |
| `publication.ts`                                       | `Publication`, the entity of the aggregate (D-085): immutable, called by the root alone                   |
| `performance-date.events.ts`                           | its domain events, the publication's included: classes, past tense, ids and facts, each with `occurredAt` |
| `performance-date.repository.ts`                       | the port: an abstract class, domain types only, one for both rows                                         |
| `performance-date.typeorm-repository.ts`               | the adapter and its row ↔ snapshot mappings                                                               |
| `performance-date.entity.ts`, `publication.entity.ts`  | `PerformanceDateRow` and `PublicationRow`, the persistence model                                          |

Messages carry no suffix (`DeclareOutcome`, `GetDateSheet`); handlers do.

**An aggregate is not its rows.** Every read path (the sheet, the public pages, the consumer, the
migrations) reads rows, whose public fields anyone can assign. The aggregate keeps an immutable
`snapshot` that only its methods replace, speaks core's types (instants as strings), and is built by
`restore()` from the row, so TypeORM never calls its constructor (`nestjs-ddd` rule 13). The snapshot
is frozen deeply, so a method copies what it keeps of its arguments (the outcome's message) rather
than freezing the caller's object. Its methods
call core's pure rules (`assertOutcomeDeclarable`, `assertCommandedTransition`) and never restate
them; what a rule needs beyond the aggregate is an argument (the checklist facts, a free slug,
`now`). A method never awaits: an I/O lookup (the free slug of a postponement) is made by the
handler first.

**One transaction per command: `CatalogTransactions.run(work)`** (`src/catalog-transactions.ts`). It
is `TransactionRunner`, from `@arthome-platform/transactions`, over catalog's factory
`catalogTransactionOf`. It opens `dataSource.transaction`, hands `work` the `CatalogTransaction` that
factory built, the repositories bound to that transaction's manager (`nestjs-typeorm` rule 3) and
the manager itself, and once it has committed merges every aggregate written in it with
`EventPublisher` and calls `commit()`. A rejection publishes nothing, a command may run two in turn,
and one opened inside another is refused (the library's own spec, on a toy aggregate, and
`catalog-transactions.spec.ts` on the date). An adapter keeps its loaded versions and registers each
write through one `AggregateTracker`, and its version-conditional UPDATE is `saveVersioned`, which
refuses with core's `DomainError` (`STATE_CONFLICT`, the row's current state and version), never an
HTTP exception. A new aggregate adds its repository to `catalogTransactionOf`. The `manager` carries
the command's other writes, which are all functions of an `EntityManager` already.

```ts
execute(command: DeclareOutcome) {
  return this.transactions.run((transaction) =>
    runIdempotently(transaction.manager, command.idempotency, this.clock, () =>
      this.declareIn(transaction, command),
    ),
  );
}
```

`runIdempotentlyVersioned` goes in the same place when the answer carries the version. The
idempotency record is claimed first, in the transaction; a replay loads no aggregate, so publishes
nothing. Inside, in this order: `loadDate` (the date, its show and its venue; a missing date is
404), decide through one method of the aggregate, which checks the version first, `save`,
`recordDateEvents`, answer. A handler never opens a transaction itself and never calls `commit()`.

**One aggregate, two rows (arthome-core D-085).** `PerformanceDate` owns its `Publication`: they are
one to one, share one version (the publication's, which the studio names, §0c), and every command
writes both. One repository loads both rows, the publication's `FOR UPDATE` to the commit, and
remembers the version it read; `save` writes both, the publication's row first with the
version-conditional UPDATE (`WHERE date_id AND version = <loaded>`, `affected === 1`,
`nestjs-typeorm` rule 7), then the date's when it changed, never the date's without the
publication's, so the date's `updated_at` says when the date itself did. A second command on the
date waits at its load for the first's commit, then is refused `state.conflict` by the version
check, with the state and version it left; the conditional UPDATE stays the save's own guard, and
refuses the same way with the row re-read. `save` inserts a date it did not load, which only
`PerformanceDate.draft` creates, the date's row first since the publication's references it. The
handler calls one method (`transitionPublication`, `declareOutcome`) and one `save`; publishing
makes the date public inside `transitionPublication`, which refuses a date that already has a slug.

**A command on a date holds its show's row** (`loadDate`, `FOR NO KEY UPDATE` to the commit, which
does not hold back a new draft's foreign key), and so does a show update, in the same order.
Publishing and the channel's face order themselves on a transaction advisory lock keyed by the
channel (`holdChannelFace`), since a face not yet created has no row to lock. Measured without them
(`dates/concurrency.itest.ts`):

- a show retitled, or an artist renamed or created, while a date was published left the new public
  row with the old copy, for good;
- two dates of one show published or postponed onto one day at once lost one to `date_show_slug`,
  answered 500;
- of two show updates at once, the second overwrote the first's fields (7 rounds in 8).

**Refusals keep their code and params.** The aggregate and the repository throw core's
`DomainError`. The transition and outcome handlers wrap exactly two calls in `asConflict` (the draft
and `RecordChecklistFact` refuse nothing as 409), which rethrows one as a 409 `RefusalException`
with the same `code`, `params` and `nature`: the aggregate's method (`transitionPublication`,
`declareOutcome`) and `dates.save`, whose `saveVersioned` refuses a change committed since the load.
That refusal is the guard of last resort: the load already holds the publication row `FOR UPDATE`,
so in catalog no change can commit between the load and the save. Those are the refusals the
contract answers 409 (`moveDatePublicationState`, `decideDateOutcome`): a state or rule said no. Any
other `DomainError` in the handler (a `media.*` or `content.*` value) is a fault in what the request
carried, so it stays unwrapped and `ErrorEnvelopeFilter` answers it 400, as on main
(`transition-publication.handler.spec.ts`). The stale version is a refusal too, checked before any
rule, as before: core's `assertCommandedTransition` for a transition, `Publication.advancedFrom` for
an outcome. A 404 or a 400 stays the `RefusalException` it was, built by `@arthome-platform/http-edge`
(`notFound()`, `stateConflict(params)`, `schemaInvalidException`). Two refusals are still built
where they are raised, each with one caller: the artist's `slugTaken` and the search's 503.
`publication.checklist_incomplete` names a list, which core's `MessageParams` cannot carry:
`PublicationChecklistIncomplete` extends `DomainError` with `missing` beside it, and the transition
handler hands `asConflict` a mapper that answers `{ missing }`.

**What happened becomes rows from the uncommitted events, inside the transaction.** A method changes
the snapshot, then `apply()`s one event per fact (no `on<Event>` handlers: nothing is replayed).
After the save the handler passes `getUncommittedEvents()` to `recordDateEvents`
(`record-date-events.ts`), once, whatever it decided; it runs these three, each ignoring the events
it does not concern:

- `writeDateIntegrationEvents` (`date-integration-events.ts`): one outbox row per event through
  `writeCatalogEvent`, in the order the aggregate applied them: publishing applies the state change,
  `DateScheduled`, then `PublicationEngaged`, so no consumer reads the lock first; the Protobuf
  payload is built there. `writeDateScheduled` writes `catalog.date.scheduled.v1` from a date's
  `PublicDateFacts` alone, which is how the public-slugs migration restates a published date without
  making an event. A domain event is never the wire format (`nestjs-ddd` rule 11); what the wire
  needs beyond it — canonical URL, venue clock, `traceparent` — comes in a context.
- `projectDateEvents` (`public/date-detail-projection.ts`): `date_detail_public`, the events folded
  into one UPDATE, since the row's `version` counts commands, or into the whole row when
  `DateScheduled` makes the date public. The read model is current when the command answers, which
  only the command's own transaction guarantees (`nestjs-cqrs`, Decide).
- `retireSlugsMovedFrom` (`public/slug-aliases.ts`): a replaced slug keeps resolving for 30 days.

A new event carries its own `kind`. `integrationEventOf` and `changesOf` switch on it and end in
`assertNever`, so an event left without its case fails `tsc`, where it used to reach the wire as
`catalog.publication.engaged.v1` (measured: an event with `PublicationEngaged`'s fields added to the
union fails both files with TS2345).

**`commit()` after the transaction, and no event handler.** None exists and none is to be added for
what the command must guarantee: the `EventBus` is in memory and fire-and-forget (`nestjs-cqrs`
rules 4 and 5), so an outbox row or a read model written there could be lost, or land after the
answer. `commit()` is still called because §12 prescribes it and it keeps a future in-process
reaction safe (rule 8). `dates.itest.ts` proves it against Postgres: when each event reaches the
bus, another connection already reads the committed outcome (every COMMIT there first waits for the
reads already started, so an event delivered inside the transaction would read the old row: measured
`[null, null]` with `commit()` moved inside `dataSource.transaction`), and a replay, a stale refusal
and a failure after the save deliver nothing (measured: 3 events with `commit()` in a `finally`).

**Controllers dispatch.** They parse the `traceparent`, build the `IdempotentRequest`
(`idempotentRequestOf`), and return `this.commands.execute(new DeclareOutcome(…))` or
`this.queries.execute(new GetDateSheet(…))`, typed by `Command<R>` / `Query<R>`.
`CqrsModule.forRoot()` is imported once, in `AppModule`; handlers go in the feature module's
`providers`, and `CatalogTransactions` comes from importing `CatalogTransactionsModule`: two
listings make two instances. Shows and venues carry no `IdempotentRequest`, since the contract gives
their routes no key, and the shows controller maps its body to core's types (§2(g)).

**The checklist consumer dispatches too.** `consumer.ts` boots `ConsumerModule`
(`consumer.module.ts`: TypeORM, `CqrsModule.forRoot()`, `ChecklistConsumerModule`, and the
`ChecklistConsumer` provider over an injected `Kafka`) as an application context, without HTTP, and
`applyChecklistMessage` turns each message it reads as a fact into `RecordChecklistFact`, whose
handler claims `processed_message` in the command's transaction. Its `ChecklistConsumer` provider
starts Kafka in `onApplicationBootstrap` and stops it in `onApplicationShutdown`, which runs for the
root module before the global TypeORM module closes the pool; `enableShutdownHooks` on SIGTERM and
SIGINT with `useProcessExit` exits 0 once closed, as before. The routing of a failure stays
AGENTS.md's ("When a message cannot be applied"): the handler refuses a date catalog does not hold
with core's `DomainError`, which the consumer rethrows as `PermanentError`, dead-lettered at once
("unknown here" for `api.not_found`, the code for any other refusal); anything else is retried as
transient. Its `TypeOrmModule.forRoot` keeps `@nestjs/typeorm`'s startup retries (9, 3 s apart), so
a wrong `DATABASE_URL` exits after about 24 s rather than at once: the API process starts the same
way, and a database still starting is the common case.

**Queries read rows, never aggregates.** `GetDateSheetHandler` reads its rows (`dateRecordsOf`,
`date-records.ts`) in one `REPEATABLE READ` transaction, since the aggregate's version lives on the
publication row, read apart from the date row, and two snapshots could serve a version the sheet
does not show, and shapes them with the pure `dateSheet()`. No port: a read has no invariant to
protect.

**The storefront's reads are queries.** `GetDateDetail`, `GetArtistDetail` and `ResolvePublicLink`
(`src/public/`) read rows the same way and answer a `PerishableResponse`. `SearchCatalog`
(`src/search/`) carries what `x-arthome-deadline` leaves and the caller's `AbortSignal`, both built
by the controller, and its handler bounds and aborts the OpenSearch request with them:
`search-catalog.handler.spec.ts` proves it through the bus, and from an HTTP caller hanging up
through `SearchModule`. `public.http.itest.ts` is `PublicModule`'s wiring suite. Measured on
2026-09-27: every HTTP answer of that suite and of `search.itest.ts` came out byte for byte the same
before and after the move to the bus, the seeded artist's `joinedAt` aside.

**Tests.** An aggregate: plain Vitest, `restore()` a snapshot, call the method, assert `snapshot`
and `getUncommittedEvents()`, core never mocked (`performance-date.aggregate.spec.ts`). A handler:
through the real bus against the container database, a testing module with `CqrsModule.forRoot()`,
the handlers, `CatalogTransactions` and `{ provide: DataSource, useValue: dataSource }`, then
`init()`, which registers the handlers (`dates.itest.ts`; races in `dates/concurrency.itest.ts`).
Three specs use fakes, each for mapping or sequencing rather than SQL:
`catalog/publish-show.handler.spec.ts` (the show and its outbox row share one manager; the HTTP
suite runs the same command against Postgres), `dates/transition-publication.handler.spec.ts` (409
against 400; it recognises the idempotency INSERT by its text, so rewording that statement breaks
it) and `dates/performance-date.typeorm-repository.spec.ts` (the order of the row writes). Every
suite migrates the service's own schema (`itest/schema.ts`, from `dataSource.options`). The wiring:
`httpApp` (`@arthome-platform/testing`) boots feature modules over HTTP with the service's global
providers (`EDGE_PROVIDERS`: `@arthome-platform/http-edge`'s `edgeProviders` given catalog's `CLOCK`
and unique-violation codes, which `AppModule` binds too) and the suite's overrides, its clock first, and `dates.http.itest.ts` calls the date routes
through it; a migrated route adds its request there. `boot.itest.ts` boots the two roots themselves,
`AppModule` with OpenSearch stubbed and `ConsumerModule` with Kafka stubbed. Measured: without
`CqrsModule.forRoot()` in either, it fails to resolve `EventPublisher`. Measured: with
`DeclareOutcomeHandler` left out of `DatesModule`'s `providers`, the route answers 500 and this
suite fails; `dates.itest.ts` lists its handlers itself and cannot see it. The same suite records
the checklist facts through `ChecklistConsumerModule`. Measured: without
`RecordChecklistFactHandler` in its `providers`, it fails on "No handler found for the command".

**No aggregate where no invariant earns one.** The show, the venue and the artist are on the
`CommandBus` (`PublishShow`, `UpdateShow`, `CreateVenue`, `UpdateChannelIdentity`) with plain
handlers: each runs in `CatalogTransactions.run` and writes through its `manager`, with no port and
no domain event, so nothing reaches the bus. D-084 puts them on the bus and through the same runner,
so catalog has one way to run a write (§12 carries the row), and none holds a rule across entities
(`nestjs-ddd` rule 1). A venue is plain data. A show has no version and no state: its slug is chosen
once from lookups a method could not await, and an update replaces copy. The artist is one row, its
version checked under the row lock it always took and its slug rules all lookups, so an aggregate
would only compare what the handler had already read. Their wiring is proven over HTTP by
`catalog/catalog.http.itest.ts`: without `CreateVenueHandler` in `VenuesModule`, 500.

**What every CQRS service here shares is in `libs/`**, lifted as ticketing's first change
(arthome-core `adr-ticketing.md` §11), then the service glue ticketing had copied (T2's architecture
review, M4); never a catalog concept and never in arthome-core:

- `@arthome-platform/transactions` (`libs/transactions`): `TransactionRunner`, `AggregateTracker`
  and `saveVersioned`. The factory hands back the transaction's manager itself and its result
  reaches `work` untouched, so a class instance keeps its methods (the spread it replaced dropped
  them, while the type still promised them); a factory handing back another manager is refused.
  `writtenUnversioned` registers a write that leaves the version as loaded, which ticketing's
  conditional decrement is. `frozen` deep-freezes each snapshot an aggregate replaces;
- `@arthome-platform/http-edge`: `edgeProviders({ clock, uniqueViolations })`, the global pipe,
  filter, interceptor and guard and the system clock under the service's token; `asConflict` (a
  `DomainError` as the 409 `RefusalException`, its `params` through an optional mapper),
  `notFound()` and `stateConflict(params)`; and
  `runIdempotently`, `runIdempotentlyVersioned`, `idempotentRequestOf` and
  `idempotencyRecordTableDdl()`, which a new service's migration runs the way it runs
  `outboxTableDdl()`. Catalog's own two migrations stay as they are, and
  `migrations/idempotency-record.itest.ts` fails the day they and the DDL stop making one table;
  the library's scenarios run on the DDL's;
- `@arthome-platform/messaging`: `claimMessage(manager, messageId, topic)`, the processed-message
  claim the three consumers each held a copy of, and `messageIdOf(payload)`, which refuses an
  absent or malformed `message-id` as permanent at the consume edge.

Nothing else is generic: aggregates extend `@nestjs/cqrs`'s `AggregateRoot` as it is, and the
events-to-outbox mapping builds catalog's own payloads over `writeOutboxEvent`, already shared.
Ticketing is the second consumer, which shapes the interface rather than a guess
(`nestjs-monorepo` rule 6).

Decided here, and each could have gone the other way:

- **The entities were renamed `PerformanceDateRow` and `PublicationRow`**, so the aggregate and its
  entity carry the domain names; the tables did not move.
- **Handlers reached from HTTP alone throw `RefusalException`**, not domain errors mapped at an
  edge. `RecordChecklistFact`, reached from Kafka alone, throws `DomainError`, mapped by the
  consumer. The day a consumer dispatches an HTTP one, its `asConflict` calls move from the handler
  to the controller (`nestjs-request-pipeline` rule 1).
- **A lost race on the version answers the version committed since**, re-read, as a transition
  always did; the outcome path used to answer the one it had read. Only two concurrent commands see
  the difference.
- **A postponement's free slug is looked up before core's rule runs**, so a refused one costs those
  reads: the aggregate takes it as an argument, and its methods do not await. A transition looks one
  up whenever the date has none, publishing or not.
- **A command on a date locks its publication's row and its show's row to the commit** (`findById`,
  `loadDate`), and a checklist fact takes the publication's `FOR SHARE`: a second command on the
  date, a fact the publication decides on, a show update and another date of the show picking a slug
  wait for it. Two shows of one title published at once answer the loser 409 `state.conflict`, where
  it answered 500.

Known and left as they are:

- `satisfiedChecklistItems`, the input of publishing's checklist rule, is computed in
  `date-sheet.ts`, the sheet's shaping module; moving it beside the aggregate would make the read
  model depend on the write side rather than the reverse.
- `PublicationChecklistIncomplete` carries `missing` beside core's scalar `params`: only the
  transition handler's `asConflict` serves it, and a path that let it escape unwrapped would answer
  400 without the list.

## 1. What was built

| File                                                                                      | What it is                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/catalog/show.entity.ts`                                                              | the slice of the `Show` aggregate the `ShowPublished` contract exercises                                                                                                                                                                           |
| `src/migrations/1758800000000-initial.ts`                                                 | the `show` table, its channel index, and the outbox from `outboxTableDdl()` — guards included, in one step                                                                                                                                         |
| `src/catalog/publish-show.handler.ts`                                                     | the one-transaction write via `writeOutboxEvent`                                                                                                                                                                                                   |
| `src/catalog/catalog.controller.ts`                                                       | `POST /shows`, 201, `cache-control: no-store`                                                                                                                                                                                                      |
| `src/catalog/catalog.module.ts`, `src/app.module.ts`, `src/main.ts`, `src/data-source.ts` | the wiring, copied from identity                                                                                                                                                                                                                   |
| `src/catalog/publish-show.handler.spec.ts`                                                | 8 tests                                                                                                                                                                                                                                            |
| `src/catalog/catalog.controller.spec.ts`                                                  | 7 tests — not on the deliverable list; see §2(f). **Rewritten 2026-09-25**: the two `languageDependency` cases moved to `publish-show.schema.spec.ts` with the guard, and cases for the domain media rule and the malformed traceparent were added |

**Added 2026-09-25 (the HTTP edge — §2(l)):**

| File                                      | What it is                               |
| ----------------------------------------- | ---------------------------------------- |
| `src/catalog/publish-show.schema.ts`      | the zod schema for the body: every field |
| `src/catalog/publish-show.schema.spec.ts` | 10 tests                                 |

The shared edge — the filter, the guard, the refusal shape, the traceparent parser and their 26
tests — lives in **`libs/http-edge`** (`@arthome-platform/http-edge`), not here. §2(m). |
`.env.example` | `PORT=3002`, database `catalog` | | `package.json` | added `migration:run` /
`migration:revert`, identical to identity's | | `src/index.ts` | **deleted** — the placeholder;
nothing needed it |

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

> Counts re-run 2026-09-25 after §2(l) and the §2(m) extraction: 3 files, 25 tests here, plus 31 in
> `libs/http-edge`. `check:enums` and `check:language` were **not** re-run in that pass — only the
> four per-service commands were in scope — but no new string literal duplicating a vocabulary was
> introduced, and the one that would have (`'production'`, a member of `MEMBER_ROLES`) was
> deliberately avoided; `app.module.ts` says how and why.

Nothing outside `apps/catalog/**` was written. No `git`, no `docker`, no install, no repo-wide
format or lint.

## 2. What only I know

### (a) The literal gate does not cover the routing values, and it cannot

`check:enums` passes, and I ran it rather than eyeballing the surface — it is read-only, so it was
safe to use as a self-check. But it proves less than it looks like it proves here.

`'catalog.show'` and `'catalog.show.published.v1'` are **hand-written literals with no owning
constant anywhere**. `@arthome/core` has no `AGGREGATE_TYPES` and no event-type vocabulary — I
checked all 543 exported names in `available-surface.md`. The gate matches whole literals, so
`'catalog.show'` is invisible to it even though `SERVICES` declares `'catalog'`.

**So `events.md` §3's routing table is being copied by hand into every service, and nothing checks
it.** Identity did it, I did it, five services remain. A typo in an `aggregatetype` does not fail a
test — it either kills the connector (topic-unsafe, and the CHECK catches that one) or silently
publishes to a topic nobody consumes (topic-safe and wrong, which nothing catches). This is E2 in
the highest-consequence place left in the repository, and it is the one finding I would act on
first. The fix is a vocabulary in `@arthome/core` generated from `events.md` §3, or a gate that
reads that table.

### (b) `outboxTableDdl()` omits the index identity created by hand

`outboxTableDdl()` emits the columns and the four CHECK constraints, but **not**
`idx_outbox_event_created_at`. Identity created it in its own initial migration
(`apps/identity/src/migrations/1758700000000-initial.ts`, last statement). I created it too, in
`1758800000000-initial.ts`, so the two services match — but only because I noticed. The next service
has to notice independently.

It belongs in `libs/messaging/src/outbox.ts` beside the constraints, for exactly the reason the
file's own header gives for the constraints living there. I did not move it: outside my tree.

### (c) `ShowPublished` carries no displayable field, and no actor

Two contract observations, from reading
`/home/julien-metral/Dev/arthome/arthome-core/proto/arthome/catalog/v1/events.proto` (message
`ShowPublished`, lines 477–554 of the generated TS):

1. **No title, no synopsis, no slug.** `data-model.md` §2.1 puts the bilingual title and synopsis on
   the aggregate and §2.7 adds `slug_fr`/`slug_en`, but the event publishes none of them. A consumer
   of `arthome.catalog.show` — `apps/search-indexer` is the first — therefore cannot get a
   displayable or linkable field out of this topic. Its options are to call `catalog` synchronously
   (forbidden, critical-rules #1) or to index a show it cannot render. **Worth raising with whoever
   owns the proto before search-indexer commits to a projection shape.** I modelled the entity to
   match the event and said so in `show.entity.ts`.
2. **No `Actor`.** `DateDrafted` has `drafted_by`, `DateScheduled` has `scheduled_by`,
   `PublicationStateChanged` has `changed_by` — `ShowPublished`, `ShowUpdated` and `ArtistUpdated`
   have none. So a show publication cannot be attributed on the wire at all; the only channel is the
   outbox's `actor_id` column, which the router does map to an `actor-id` header
   (`infra/debezium/identity-outbox.json`, `table.fields.additional.placement`). Given §2.3 keeps
   `last_actor_id` on the publication, the asymmetry looks unintended.

### (d) `actorId` is null, and that is a gap I chose not to paper over

I write `actorId: null`. Publishing a show is a named studio act, so the studio journal is what goes
without. I left it null because **this slice has no verified actor**: JWKS verification
(critical-rules #4) is not built here, and reading a name out of a request header is precisely the
`x-user-id` that rule forbids. An unverified name in a journal that arbitrates thousands of euros is
worse than an absent one. There is a test asserting the null, so the day an actor exists it is clear
the column was deliberate and not forgotten.

### (e) Where I diverged from identity: one validated field

> **CORRECTED 2026-09-25 — the premise of this section was wrong, and it was wrong in the direction
> that hides a defect.** The paragraph below said identity "can afford" unvalidated `locale` and
> `country` because "they are text on the wire, so a wrong value arrives wrong and stays visible".
> That is true of a wrong **value** and it **inverts** for a wrong **type**. `@bufbuild/protobuf`
> 2.15.0's writer does `if (typeof value !== "string") { value = String(value); }`
> (`binary-encoding.js:241-245`), so `{"a":1}` is published as the four plausible characters
> `[object Object]`; `pg` 8.23.0's `prepareValue` (`utils.js:45-70`) sends the same object through
> `JSON.stringify`, so the column holds `{"a":1}`. The aggregate and the fact it published then
> disagree **permanently**, and `notifications.welcome_email.locale` received the second of the two.
> Being text on the wire is what made it invisible, not what made it safe. Both services now
> validate every inbound field; see §2(l).

The original text, kept because the reasoning it contains about `languageDependency` is still right
and is why that field was guarded first:

Identity lets `locale` and `country` through unvalidated, and can afford to — they are text on the
wire, so a wrong value arrives wrong and stays visible. I added **one** guard, on
`languageDependency`, in the controller:

> `languageDependency` is a Protobuf **enum**. An unknown member has no number, so the silent
> outcome is `LANGUAGE_DEPENDENCY_UNSPECIFIED` — a published fact that says nothing about the field
> the surface's most visible language rule (`hasLanguageBarrier`) reads, and nothing anywhere fails.
> That is the same class of fault the outbox's `payload_not_empty` CHECK exists to stop one level
> down, so I stopped it at the boundary, where a request is still waiting to be told.

Judgement calls inside that:

- **`isMember` from `@arthome/core`, not zod.** The correct `In` strictness is `vocabularyIn` from
  `@arthome/core/schema`, which needs zod — not a dependency of this service, and I did not add one.
  `isMember`'s own doc restricts it to paths where the value is not displayed; a write-boundary
  refusal qualifies.
- **Strict, not tolerant, and the direction is what decides.** critical-rules #10 keeps an unknown
  member raw and neutral — that is the `Out` rule. This is `In`.
- **`ApiErrorCode.SCHEMA_INVALID`, invented nothing.** `CATALOG_ERROR_CODES` are all `date.*` and
  none fits a malformed request field. `api.schema_invalid` is a transport concern about a malformed
  body, which is what this is — the usage that code's own doc comment endorses. I did **not** add a
  code to `@arthome/core`: that is the mistake identity recorded against itself with
  `ACCOUNT_STATUSES`.
- **The envelope is incomplete and I did not build it.** The refusal carries `code`, `params` and
  `nature`, all from `@arthome/core`. It does **not** carry `traceId`, and it is a bare Nest
  `BadRequestException` rather than `StorefrontErrorEnvelopeSchema` — which lives in
  `@arthome/contracts/envelope`, also not a dependency here. Identity has no error path at all, so
  there was nothing to mirror. **This is the one place my slice emits a shape that critical-rules #8
  would not fully accept.**

  > **Built 2026-09-25 — §2(l).** `@arthome-platform/http-edge`'s `ErrorEnvelopeFilter` now serves
  > `transport.md` §5.5's `{ error: { code, nature, params, traceId }, servedAt }` for **every**
  > error, so the 400 and the 500 are one shape. `traceId` turned out to be buildable after all:
  > §5.5 defines it as the `trace-id` field of the `traceparent`, and the parse that item 2 added
  > for the header yields it. `StorefrontErrorEnvelopeSchema` is still not used, and still for the
  > reason given here — it is a BFF contract shape and this service does not depend on that package.
  > What §5.5 asks for that is still missing is the **success** envelope, and three codes the
  > vocabulary does not carry; both are set out in §2(l).

### (f) The `languageDependency` encoding, and why it is not a parallel literal table

`WIRE_LANGUAGE_DEPENDENCY` in `wire.ts` maps `@arthome/core`'s `LanguageDependency` to the generated
Protobuf enum. §5.2 says "a transform is the parallel literal table wearing a codec's costume", so
this needed justifying rather than just writing:

- what §5.2 forbids is two live **spellings** with a function asserting they agree. Here there is
  one spelling — core's, which is also the wire's — and a Protobuf enum, which is a **number** on
  the wire whatever anyone prefers;
- **no literal on either side**: the keys are computed from core's named members, the values are
  protobuf-es's generated enum. Neither spelling nor number is retyped;
- `satisfies Record<LanguageDependency, …>` makes it exhaustive **in the domain direction**: a
  fourth member in `LANGUAGE_DEPENDENCIES` fails the build. The reverse is deliberately not checked
  — the proto's `UNSPECIFIED = 0` has no domain member and must not gain one.

I also added `catalog.controller.spec.ts`, which is **not** on the deliverable list. Reason: the
refusal path above is a branch I introduced, and an untested throw is a liability. Four tests: the
refusal happens, nothing reaches the transaction, the body is a code and not a sentence, and the
traceparent survives. Say so if the extra file is unwanted — the four tests delete cleanly.

### (g) `MediaSet` needed no conversion, and that decided the command's type

`@arthome/core`'s `Rendition` and `arthome.common.v1.ImageRendition` agree field for field — `url`,
`widthPx`, `heightPx`. So `media` goes into `create()` with only a spread (readonly → mutable), and
I typed the command with core's `MediaSet` rather than a local shape specifically so there would be
nothing to map. A local shape would have manufactured a transform.

I included `media` rather than leaving it unset on purpose: it is the one nested message on
`ShowPublished`, so it is what makes the payload round-trip test prove the nested encoding and not
just scalars.

### (h) Deliberate omissions from the entity

Each is commented in `show.entity.ts`. Summary: bilingual title/synopsis, cast and the per-language
slugs (§2.1, §2.7) are out because the event carries none of them and nothing in the slice reads
them back; `version` is out because optimistic concurrency belongs to `Publication`'s transitions
(§2.3) and a publish here is one insert with no prior state; `attributes{}` is out (§2.6) for the
same reason as the slugs.

The column is `category_id`, not `discipline`: `data-model.md` §2.1 says "discipline" and the
published contract says `category_id`. The wire wins (§5.2 — the wire is the side that is expensive
to change), and I noted the divergence in the entity so the next reader does not "fix" it.

### (i) The table name is quoted, and that is deliberate

`CREATE TABLE "show"` — `SHOW` is a Postgres command word. It is unreserved, so the unquoted form
happens to parse today; TypeORM quotes it in every statement it generates from `@Entity('show')`, so
an unquoted migration would be the one spelling that differs. Commented in the migration.

### (j) Outside my tree, noticed while running the gates

- **`libs/events/src/index.ts`** — the blocker below. Resolved by the lead while I worked.
- **`apps/search-indexer/src/consumer/show-consumer.ts:31`** — `pnpm run typecheck` (the root
  program) fails with `TS6133: 'ShowProjection' is declared but its value is never read`. That is
  the other agent's in-flight file, almost certainly transient. Recording it only so nobody
  attributes a red root typecheck to `catalog`: **no error in the root run came from
  `apps/catalog/**`**, and `apps/catalog`'s own typecheck is clean.
- **`libs/events/src/index.ts`** — the flat barrel. Its own subsection, §2(k): it is the one item
  here that carries an instruction for whoever reads this next.
- **`apps/notifications/src/data-source.ts`** does not call `readEnv()` while
  `apps/identity/src/data-source.ts` does. I followed identity. Cosmetic, but the two services
  disagree about where configuration is read.

### (k) The events barrel is on borrowed time — and is NOT to be worked around

`@arthome-platform/events` has a single `.` entry point that `export *`s three generated files. That
is exactly the shape that breaks the day two contexts name the same message, and the durable answer
is the one `@arthome/contracts` already applies to itself: no `.` entry point at all, one subpath
per context, so a service declares which contexts it speaks.

Two things make this more than a style note for `catalog` specifically:

- **The collision it predicts would land on this service's import first.** Catalog's
  `LanguageDependency` already collides by name with `@arthome/core`'s — a Protobuf number against a
  domain string — and `wire.ts` has to alias one of them. That is the near miss, one package short
  of being a real conflict.
- **The headroom is measured, not assumed.** Recounted on 2026-09-26 when catalog began consuming
  ticketing, streaming and chat: common exports 15 names, identity 35, catalog 41, ticketing 53,
  streaming 35, chat 29, and every pairwise intersection is empty. A future collision would not pass
  silently either: TypeScript refuses an ambiguous `export *` (TS2308), so the typecheck guards the
  barrel until it is split.

**The instruction, and it is the lead's, not mine:** the restructuring into per-context subpaths is
owned by the lead and happens after wave 2. Until then every service keeps importing from
`@arthome-platform/events` exactly as it does now. Do not pre-empt it with a deep import, a local
alias module or a second entry point — three agents on three import conventions costs more than the
one import that will have to change later.

### (l) The HTTP edge, added 2026-09-25 — validation, the error envelope, and the guard

Added in a later pass, against `nestjs-validation`, `nestjs-request-pipeline`, `nestjs-http` and
`nestjs-auth` — the skills that were not loaded when this service was first written, which is why
§2(e) got identity's validation boundary wrong and why the "do this next" in §4 was false.

| File                                 | What it is                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `src/catalog/publish-show.schema.ts` | the zod schema for the `POST /shows` body — **every** field, not one                                       |
| `libs/http-edge/**`                  | the shared edge, extracted in the same pass — §2(m)                                                        |
| `src/app.module.ts`                  | `APP_PIPE`, `APP_FILTER`, `APP_GUARD` — there was no global enhancer of any kind in this repository before |

The filter, the guard, the refusal shape and the traceparent parser were written here first, then
**extracted to `@arthome-platform/http-edge`** in the same pass — see §2(m). This service imports
them; it holds no copy.

**The pipe mechanism.** `StandardSchemaValidationPipe` **does** exist in the installed
`@nestjs/common` 12.0.3 (`pipes/standard-schema-validation.pipe.d.ts`, re-exported from
`pipes/index.d.ts`). It reads `metadata.schema`, defaults `transform: true`, and takes
`exceptionFactory(issues)`. It is bound as `{ provide: APP_PIPE, useValue: … }`. `@Body({ schema })`
is real too — `Body(options: ParameterDecoratorOptions)` with `schema?: StandardSchemaV1`. **A
schema alone validates nothing**: it is metadata, and the pipe is what reads it, so the two halves
are useless apart.

**`@Headers` genuinely cannot be validated by a pipe**, confirmed in the same package: it is
declared `Headers: (property?: string) => ParameterDecorator` — no options object, therefore no
`schema`. The `traceparent` is parsed by hand in the controller, and a malformed one is dropped to
`null` rather than refused, which is the decision `catalog.controller.ts` recorded and this keeps.

**The `languageDependency` guard moved rather than disappeared.** §2(e) said the right form was
`vocabularyIn` from `@arthome/core/schema` and that zod was not a dependency. zod 4.6.5 is a
dependency of this service now, so the schema carries `vocabularyIn(LANGUAGE_DEPENDENCIES)` and the
controller's `isMember` check is gone. The reasoning in §2(e) about _why_ that field is guarded is
unchanged and still the sharpest case on this endpoint.

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
  data rather than assumed: `music`, `stage`, `jazz`, `theatre`, `contemporary`, `ballet-classique`,
  `open-air` all match it. This is **shape** strictness; membership in the taxonomy is deliberately
  NOT checked, because the taxonomy is data that gains and loses members and a list of them here
  would be a parallel table going stale (critical-rules #10).
- **`spokenLanguages` is `z.string().min(1)`, NOT `LocaleIn`.** `show.entity.ts` separates the two
  in as many words — this is what is PERFORMED, "unrelated to the display locale (`LOCALES`)" — and
  `LOCALES` has two members, so `LocaleIn` would refuse a show performed in German. `@arthome/core`
  publishes no BCP 47 primitive and inventing a language-tag regex in a service is what
  `available-surface.md` opens by asking nobody to do.
- **`media` is checked for shape here and for its RULE by `@arthome/core`'s `rendition()`.** That
  function already refuses an empty url (`media.url_empty`) and a non-integer or non-positive
  dimension (`media.size_invalid`), both published codes. Putting `.url()` and `.positive()` in the
  schema as well would be a second implementation of a rule the domain owns — critical-rules #2
  allows two calls and never two implementations. The cost, accepted: `rendition()` throws on the
  first bad image, so a body with two is told about one. Before this, `body.media` was passed
  straight through as a `MediaSet` with nothing having checked it.
- **`runtimeMin` is bounded by `2 ** 32 - 1`, written as arithmetic.** A wire limit, not a domain
  constant, so it is declared locally rather than referenced from an owning document (critical-rules
  #15). It turns the rollback-and-500 described in the §4 correction into a 400.
- **Deliberately permissive fields are marked as such.** An audit noted that
  `@Body() body: RegisterBody` is byte-identical between "I decided this field is free-form" and "I
  never considered it". Every field above that is shape-only rather than member-strict says so in
  the schema with the reason, so the next reader can tell a decision from an omission.

**`transport.md` §5.5 was missing three codes this edge needed — all three now exist.** §5.5's
status table is **pre-D-067**: written in SCREAMING_SNAKE throughout, while D-067 converted every
code to dotted lowercase. Measured against the arrays `@arthome/core` actually exports, that table
**promises 28 code names and 12 were emittable by nobody.** Three of the twelve blocked this edge,
and all three were published during the pass (arthome-core `63ca16a`, `60ec163`):

| §5.5 says             | Status | Now                                                                                   |
| --------------------- | ------ | ------------------------------------------------------------------------------------- |
| `STATE_CONFLICT`      | 409    | **no generic member, by design** — a 409 carries the code naming the specific refusal |
| `INTERNAL`            | 500    | `ApiErrorCode.INTERNAL`                                                               |
| `SERVICE_UNAVAILABLE` | 503    | `ApiErrorCode.SERVICE_UNAVAILABLE`                                                    |

Two named constants held knowingly-wrong stand-ins for a few hours; **both are deleted rather than
repointed**, because a constant whose only content is `= ApiErrorCode.INTERNAL` names nothing.

**`api.upstream_unavailable` IS NOT EMITTED BY EITHER SERVICE, and a test asserts no path does.** It
means "a service behind the BFF failed" — false said about ourselves, and it destroyed the one
distinction a caller acts on, since one substitute answered 500, 502 and 503 alike while **503 is
retryable and 500 is not.**

**A UNIQUE VIOLATION ANSWERS 409 ONLY WHEN `src/unique-violations.ts` NAMES ITS COLUMN.** A generic
conflict code was ruled out — the published `Conflict` description reads "Definitive business
refusal. The `code` says which one" — so an unmapped violation answers 500 and logs the gap by name.
`apps/identity/src/unique-violations.spec.ts` is the pattern for a test that reads the migrations
and fails when a constrained column has no code; catalog has none yet.

Two smaller points, one since reconciled:

- ~~**Success responses still carry no `servedAt`.**~~ **DONE — `SuccessEnvelopeInterceptor` in
  `@arthome-platform/http-edge`** wraps every success body as `{ servedAt, data }`, per
  critical-rules #9 and §5.5. On the running stack on 2026-09-26, `POST /shows` answered
  `{"servedAt":…,"data":{"showId":…}}`.
- **An unrecognised key is refused without being named.** Measured: zod's issue for that case is
  `{ code: 'unrecognized_keys', keys: ['…'], path: [] }` — the key is in `keys` and `path` is
  **empty**, so `params.fields` has nothing to report. `keys` is not reachable, because
  `exceptionFactory` is typed against Standard Schema's `Issue`, which declares only `message` and
  `path`. The refusal is correct; only "which key" is missing, and it is missing for every Standard
  Schema validator.

### (m) The HTTP edge is a library, `@arthome-platform/http-edge` — and it was briefly duplicated

The filter, the guard, the refusal shape and the traceparent parser were written into
`apps/identity/src/http/` and `apps/catalog/src/http/` first, because `libs/**` was outside the
pass's trees. That is two implementations of one thing, which critical-rules #2 forbids in as many
words — "two calls are allowed, two implementations never" — so it was reported rather than left,
and the lead scaffolded `libs/http-edge` in response. The extraction was then completed in the same
pass.

**Why the move was safe, measured rather than hoped:** with comments stripped, the two service
copies were **byte-identical**. They were kept that way deliberately while they existed, so the diff
was empty and the move could not silently drop a branch. Verified by comparing them with comments
removed before deleting either.

`@arthome-platform/http-edge` has since gained the success envelope and the health routes;
`libs/http-edge/src/index.ts` is the list of what it exports.

**WHAT STAYS IN A SERVICE**: its endpoint schema, and the table binding each uniquely-constrained
column to its code. The library knows how to _match_ a constraint name; only the service knows what
its columns mean. This service's table is empty, legitimately.

**THE LIBRARY MUST BE BUILT ONCE BEFORE A PER-SERVICE `vitest` RUN WILL RESOLVE IT**, and the
failure names the wrong thing. `pnpm --filter @arthome-platform/catalog exec vitest run` invoked
from the service directory does **not** read the root `vitest.config.mjs`, so it resolves the
workspace dependency through the `default` export condition — `dist/index.js` — and reports "Failed
to resolve entry for package @arthome-platform/http-edge. The package may have incorrect
main/module/exports specified in its package.json", which sends the reader to a manifest that is
fine. The root config's own header comment describes exactly this trap for
`@arthome-platform/messaging`; the fix there is `resolve.conditions: ['@arthome/source']`, which the
root suite has and a per-service invocation does not. `dist/` is gitignored and every other library
has a locally built one, so: `pnpm --filter @arthome-platform/http-edge run build`.

**THE LIBRARY DEPENDS ON NEITHER `typeorm` NOR `zod`, AND MUST NOT START.** It duck-types the pg
error's `code` and `driverError.code` rather than `instanceof QueryFailedError`, so the transport
layer does not depend on the ORM; and the pipe's `exceptionFactory` types its issues structurally.
Both were in the first scaffold and were removed.

### (n) Where a schema belongs, and why "DTOs live in contracts" is the wrong move here

**The line is who consumes the shape, not which repository it sits in.**

- **frontend ↔ BFF** → `@arthome/contracts` in arthome-core. Those schemas exist so the storefront
  and the studio share them instead of doing the same work twice; a browser has to have them. That
  is why the package has 15 subpaths, and why `check:emit-diff` compares all 111 of their schemas
  against the two OpenAPI documents — which are, in the README's own words, "the contracts of the
  two BFFs".
- **BFF → service** → stays in arthome-platform, permanently. `POST /accounts` and `POST /shows`
  appear in no OpenAPI document and no frontend will ever call them.

So `publish-show.schema.ts` lives beside its controller and **stays there**. It is not waiting for a
BFF to be extracted into a shared package: when a BFF is written, the shape that belongs in
`@arthome/contracts` is the BFF's own **client-facing** request and response schema, because the
frontends consume that one. This service's inbound shape is not the same shape and never becomes it.

**THE MOVE THAT LOOKS OBVIOUS IS THE HARMFUL ONE.** "These are DTOs, DTOs live in contracts" would
put a service's internal input shape on a package every browser installs, and would then have
`check:emit-diff` compare it against an OpenAPI document that does not describe it. Recorded because
the reasoning is not visible from either file.

## 3. Blockers

**One, and it was resolved during the work.** `ShowPublishedSchema` was unreachable:
`libs/events/src/index.ts` re-exported only `common` and `identity`, while the generated code was
already present in `libs/events/src/gen/arthome/catalog/v1/events_pb.ts`. Verified with

```
cd apps/catalog && node -e "import('@arthome-platform/events').then(m=>console.log(Object.keys(m).filter(k=>/Show/.test(k))))"
```

which printed nothing. That file is outside my tree, so **I did not touch it**; I reported it to the
lead with the exact one-line fix and built the whole slice against the real import in the meantime,
with a marked TODO at that import and nowhere else. The lead added
`export * from './gen/arthome/catalog/v1/events_pb.js';` and rebuilt the package. I then **removed
the TODO** — a stale blocker note is worse than none — and re-ran every gate. The same check now
prints `ShowPublishedSchema ShowUpdatedSchema`, 59 runtime exports.

No other blocker. I never needed a shim, and no hand-written copy of a generated descriptor exists
anywhere in this tree.

## 4. What I did NOT do, and what remains

**Verified against a running stack since 2026-09-26** (`2feee34`): the migration ran, the
`catalog-outbox` connector was registered, a `POST /shows` reached `arthome.catalog.show` and was
indexed by `search-indexer`, and the version guard refused an older fact. The same day a lost outbox
row was found and republished (`republish:outbox`). The two prerequisites this section once listed
outside `apps/catalog/**`, the connector file and catalog's `migration:run` in `AGENTS.md`, both
exist.

**Owed inside this service, and deliberately not built:**

- ~~**No `ValidationPipe`, no DTO, no `@arthome/contracts` schema.**~~ **DONE — see §2(l).**

  > **CORRECTED 2026-09-25 — the "do this next" in this bullet was false, and a wrong instruction
  > costs more than a silence because it gets carried out.** It read: "`runtimeMin` is the one I
  > would do next: it is `uint32` on the wire, so a negative value does not fail — it encodes as a
  > large positive number."
  >
  > It does fail. On the installed `@bufbuild/protobuf` 2.15.0, `assertUInt32`
  > (`binary-encoding.js:692-702`) throws on a negative, on a non-integer **and** on a non-number,
  > and `toBinary` runs **inside** the transaction (`publish-show.handler.ts`), so `runtimeMin: -1`
  > rolls back and publishes nothing — a 500 for a bad request, which is the wrong status but not a
  > corrupt record.
  >
  > **The numeric fields were accidentally guarded; the STRING fields were the unguarded ones** —
  > the exact inverse of what this bullet directed attention to. `genreIds: "abc"` was the real
  > defect: the service spreads that value twice, once into the event and once into the row, and
  > spreading a string yields its characters, so three genre ids nobody sent were committed,
  > published in `ShowPublished.genre_ids`, and indexed.
  >
  > The bullet's closing sentence was also reopened and decided the other way: the project owner
  > ruled that the schema is **zod** and lives **in the service, beside its controller** — not in
  > `@arthome/contracts/catalog`. Those documents are the two BFFs' contracts, and `POST /shows`
  > appears in no OpenAPI document, so a schema there would be contract for a consumer that does not
  > exist (`nestjs-monorepo` rule 6). When a BFF exists, both it and this service live in this
  > repository and the shared shape can be extracted then.

- **No authentication and no authorisation.** critical-rules #4 and #5 both apply to `POST /shows`
  and neither is implemented — as in identity. Anyone who can reach the port can publish a show for
  any channel.

  **Partly addressed, and only the part that was not deferred.** `adr-auth.md` defers authentication
  and that is untouched. What was fixed is that the route no longer ships _reachable_:
  `DenyInProductionGuard` is bound globally and refuses every request when `NODE_ENV` is neither
  `development` nor `test`. critical-rules #5 forbids the "only the BFF calls me" argument, and this
  is what forces the question to be answered rather than assumed. See §2(l). The date commands are
  in the same position: `canDecide` is true for every caller, where it must come from the operator's
  verified rights.

- ~~**No idempotency key.**~~ **DONE for the date commands** (2026-09-26): `idempotency_record`,
  written inside the command's transaction, covers transport.md §5.4's four cases. `POST /shows`
  still takes none: no contract describes it.
- ~~**No error envelope.**~~ **DONE — `@arthome-platform/http-edge`, §2(l) and §2(m).** It now
  carries `traceId` too, which §2(e) recorded as owed: the same parse that validates the inbound
  `traceparent` yields the 32-hex trace-id `transport.md` §5.5 defines it as.
- ~~**No consumer.**~~ **DONE** (2026-09-26): `dist/consumer.js` projects the publication checklist
  from `arthome.ticketing.date_sales`, `arthome.streaming.run` and `arthome.chat.date`, retrying and
  dead-lettering on `arthome.catalog.retry` / `.dlq`.
- **Dates and publication, partly.** Built on 2026-09-26: `Date`, `Publication` (the commanded
  transitions, the version condition, the checklist gate), `Venue`, and the events `DateDrafted`,
  `PublicationStateChanged`, `DateScheduled`, `PublicationEngaged` and `ShowUpdated`, then on
  2026-09-27 `DateOutcomeDeclared` and `DateRescheduled` (§0c). Still owed: `DateReplayPolicySet`,
  `DateRightsChanged`, a reschedule without an outcome, the two transitions `streaming` causes
  (`technical -> live`, `live -> ended`), `Taxonomy` and `SavedSearch`. `Artist` since 2026-09-27
  (§0d).
