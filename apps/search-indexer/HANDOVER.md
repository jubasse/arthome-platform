# search-indexer — handover

Wave 2, agent C. Everything below `apps/search-indexer/` and nothing else was written.

## 0. Since wave 2: a read model, and the date index (2026-09-26)

The indexer now keeps its own copy of shows and dates, fed only by events, and composes every
document from it. That was needed twice over: a date document carries its show's fields, which
arrive on another topic and change (`ShowUpdated`), and a partial update cannot be applied to a
document built from one event alone. It supersedes §3's ordering and §4's "ledger, never a decision
input"; both are marked where they stand.

- **`show_projection`** holds the show in two groups, each versioned by the `occurred_at` of the
  fact that set it: what only `ShowPublished` states, and what `ShowUpdated` replaces. An update
  that overtakes the publication on a retry topic keeps its fields when the publication lands.
- **`date_projection`** holds what `DateScheduled` makes public and the publication state, each
  guarded by its own version (the state by the publication's own `version`). A date is indexed
  once scheduled, never before: before publication it is not public.
- **`arthome-catalog-date`** (alias, `-v1` behind it): one document per public date, with its
  show's identifiers, taxonomy, language and titles copied in. Its version is `doc_version`, a
  counter advanced under the date row's lock each time the document is recomposed, whichever input
  changed; a show change recomposes every public date of the show.
- **Order: the read model commits, then the documents are written from it.** A crash in between
  leaves the offset uncommitted, the message returns as a duplicate, and a duplicate rewrites the
  documents from the read model at their current versions. So there is no silent gap, and a replay
  is still a rebuild: the two properties §3 chose its ordering to keep.
- Titles and synopses are searchable: `ShowPublished` and `ShowUpdated` carry them since
  arthome-core `068a7cd`, as `title_fr` / `title_en` with the French and English analyzers.
- Proven against real stores in `src/consumer/indexer.itest.ts` (10 cases): the partial update,
  the update before the publication, the date before its show, a show update reaching its dates,
  the state that overtakes `DateScheduled`, a stemmed title search, and a draft never indexed.
- Rows written before the migration have no fields: replay `arthome.catalog.show` to fill them.
- **The index definitions live in `libs/search-index`** since catalog reads the date index for
  `/v1/search`: the writer and the reader share one mapping and one document type.
- **A date document also carries `slug_fr`, `slug_en`, `ends_at` and `over_at`**: the slugs from
  `DateScheduled` (arthome-core `3b6eefa`), the two instants computed by `@arthome/core` when the
  document is composed, so a query compares instants instead of re-deriving the rule. All four are
  additive: `ensureIndices` puts them on the live `-v1`. A document written before them lacks them,
  and catalog's search filters on `over_at`, so such a date is not searchable until recomposed;
  replaying `arthome.catalog.date` does it, since a duplicate rewrites the document.

## 1. What was built

| File | What it is |
| --- | --- |
| `src/index/show-document.ts` | the document shape, the index name and alias, the settings and the mapping — one justification per field |
| `src/index/opensearch-client.ts` | the client, the `ShowIndex` port, index creation + additive mapping migration, and the status classification (409 / 400 / everything else) |
| `src/index/opensearch-client.spec.ts` | 4 tests of that classification, against a fake `Client` |
| `src/consumer/show-consumer.ts` | decode → project → index → dedupe, and the ordering decision (§3) |
| `src/consumer/show-consumer.spec.ts` | 15 tests, fake `ShowIndex` + fake `DataSource`, no containers |
| `src/consumer/processed-message.entity.ts` | the dedup row, in the `search` database |
| `src/consumer/show-projection.entity.ts` | the projection ledger — written inside the same transaction, never read to decide |
| `src/migrations/1758700400000-initial.ts` | both tables, plus an index on `show_projection.indexed_at` |
| `src/data-source.ts` | the `search` database, `synchronize: false` |
| `src/main.ts` | `ensureShowIndex` at startup, `runConsumers`, graceful shutdown in the order that matters |
| `package.json` | added `migration:run` (the only manifest change) |

`src/index.ts` (the placeholder) is deleted.

### Verified, exactly these

```
pnpm --filter @arthome-platform/search-indexer exec tsc --noEmit -p tsconfig.json   # clean
pnpm --filter @arthome-platform/search-indexer exec vitest run                      # 19 passed, 2 files
pnpm --filter @arthome-platform/search-indexer exec prettier --check "src/**/*.ts"  # clean
pnpm --filter @arthome-platform/search-indexer exec eslint src --max-warnings 0     # clean
```

Also run, because `migration:run` depends on it: `tsc -p tsconfig.build.json` emits, and
`dist/data-source.js`, `dist/consumer/show-consumer.js` and `dist/index/*.js` all import cleanly
under real Node ESM (a different resolution path from Vitest's — see §5).

**Not verified, and it cannot be from here:** nothing was run against a live OpenSearch, Kafka or
Postgres. `docker` was forbidden. So `ensureShowIndex`, the 404 handling in `indexExists`, the
actual behaviour of `version_type: external_gte`, and the claim that a strict-mapping rejection
answers 400 are all **reasoned from the client's typings and the OpenSearch API, not observed**.
§6 lists what a first live run should check.

---

## 2. The index mapping, and why

Index `arthome-catalog-show-v1`, written and read through the alias **`arthome-catalog-show`**.

### The finding that shaped everything: there is no text to search

> **RESOLVED 2026-09-26** — the proto now carries title and synopsis (§0). What follows is why the
> first mapping had no text field.

`ShowPublished` carries **no title, no synopsis, no artist name** — only identifiers, vocabulary
members, a runtime, language tags and image renditions. So this index supports **filtering and
faceting**, not matching a query string, and the mapping is built for that rather than pretending
otherwise. A `title` field the projection could never populate would be worse than none: a `match`
against an always-absent field returns zero hits and reads as a relevance problem instead of a
missing contract field.

Getting full-text here needs one of two things, and both are outside this service:
a denormalised title on the wire (a `catalog` contract change), or a lookup into `catalog`'s own
store — which critical-rules.md §1 forbids. **This is the single most important thing to decide
before anyone calls the search feature done.**

### Field by field

| Field | Type | Why |
| --- | --- | --- |
| `show_id` | `keyword` | also the `_id`, stored again because `_id` has no doc values and so cannot be aggregated or sorted on |
| `channel_id`, `artist_id`, `category_id` | `keyword` | filters and facets |
| `genre_ids`, `tag_ids` | `keyword` | multi-valued facets |
| `runtime_min` | `integer` | range filters; `integer` and not `short` because the wire says `uint32`, and a mapping narrower than the contract rejects instead of storing |
| `language_dependency` | `keyword`, **no `null_value`** | an unspecified dependency is genuinely absent; substituting a member would make those shows answer a filter for that member |
| `spoken/subtitle/surtitle_languages` | `keyword` + **`arthome_lowercase` normalizer** | see below |
| `media` | `object`, **`enabled: false`** | carried in `_source` for the result card, indexed not at all |
| `published_at`, `indexed_at` | `date` | ISO 8601 UTC strings (critical-rules.md §6) |

**Everything is `keyword`, never `text`.** A `text` field is analysed, so `cirque_contemporain`
would be split and a filter for `contemporain` would match it — wrong in the direction that returns
*more* results, and nobody files a bug about extra hits. `keyword` is also what carries doc values,
which is what the `terms` aggregations behind facet counts need.

**The normalizer is the one mapping decision that changes an answer.** BCP 47 is case-insensitive:
`fr-FR`, `fr-fr` and `FR-fr` are one tag, and a bare `keyword` field would index them as three
terms — a language filter that silently misses shows. A normalizer folds the **indexed** term
without touching `_source`, so the surface still displays the tag as it was authored *and* filters
on it reliably. Lower-casing in the projection instead would fix the filter and destroy the
display.

**Its named limit:** the tag is indexed whole, so `fr` does **not** match `fr-FR`. The additive fix,
the day an "any French show" filter is actually specified, is a derived `…_primary` field holding
the primary subtag. It is deliberately not built now — a second field with no reader and no test is
how a projection starts disagreeing with itself.

**`media` is `enabled: false`, not omitted.** A result card needs the whole rendition ladder so the
surface picks its own size (a 4K background decoded for a thumbnail is the first source of memory
pressure on a television). But nothing searches by image URL, and `keyword` there would add one
inverted-index term per URL per rendition per show for no query at all.

**`dynamic: 'strict'`.** The default, `true`, lets the *first* document carrying a new field decide
that field's type for the life of the index: a `runtime_min` that ever arrives as a string becomes
`text`, and every range query after it returns nothing, permanently and silently. Strict turns that
into a 400 on the write, which this consumer classifies as permanent (§4) and dead-letters where
somebody sees it. Strictness applies to the **shape**; an unknown vocabulary member is still kept
and treated as neutral (critical-rules.md §10) — different rules, both held.

**One shard, for a relevance reason and not a size one.** Scoring is per shard, so document
frequency is counted per shard. On a catalogue this small, splitting it means two documents with the
same content score differently depending on which shard they hashed onto, and the symptom is a
result order that changes when a document is reindexed.

**Zero replicas is a development value** and must be raised before any real deployment — see §6.

**Alias, not the concrete index.** A non-additive mapping change (a field's type, an analyzer on an
existing field, the shard count) cannot be applied in place; the path is build `…-v2`, reindex, move
the alias in one `_aliases` call. If the writer or the readers named `…-v1`, that swap would need
every one of them redeployed in step.

---

## 3. The dual-write ordering — the answer, stated plainly

> **SUPERSEDED 2026-09-26 by §0.** The precondition written at the end of this section no longer
> holds: the projection reads a read model. The order is now commit first, index after, and a
> duplicate rebuilds from the read model, which keeps both properties argued for here.

**The index write happens first. The Postgres transaction commits last.**

An OpenSearch write and a Postgres transaction cannot commit together. There is no safe ordering;
there are two, each wrong in a different way, and the job is choosing **which way to be wrong**.

- **Index first, commit after (chosen).** Crash in between: the document is in the index, the
  `processed_message` row is not. The message is redelivered, the handler re-indexes the same
  document — the projection is pure, so it is the same document — and commits the row. **The
  failure mode is a repeat.**
- **Commit first, index after.** Crash in between: Postgres says "processed", the index has
  nothing. The redelivery finds the row, reports `duplicate`, skips. The show is absent from search
  for ever; nothing logs it, no alert fires, and the repair is a full reindex nobody knows to run.
  **The failure mode is a silent gap.**

A repeat is absorbed by an idempotent write. A gap is absorbed by nothing. So the non-transactional,
idempotent write goes first and the transactional bookkeeping goes last.

**What `processed_message` therefore means here is narrower than in `notifications`:** "the
OpenSearch write for this message has been observed to succeed". Its *absence* means "not known to
have succeeded", never "known not to have" — and that asymmetry is what makes re-application safe
and required.

**The cost is not a cost, it is the rebuild path.** Because the index write happens *before* the
dedup check, replaying `arthome.catalog.show` from the beginning rebuilds the index even though
every message is already claimed: the writes land, the rows do not move. Under the other ordering
the same replay would do nothing, and restoring a lost index would first require truncating
`processed_message` — deleting the evidence in order to repair the thing the evidence was about.
`show-consumer.spec.ts` asserts this directly ("still writes the index on a duplicate").

**What is not claimed:** that a repeat is free. A redelivered message costs one redundant index
write. A cheap `SELECT` before the index write would avoid it — and would also disable the rebuild
path, so it is deliberately absent.

**The precondition, and it is the thing to re-check:** this is only correct while the projection is
a **pure function of the event**. The day it reads the current document and increments something,
the ordering stops being correct. That is written above `projectShow`.

---

## 4. What only I know — the other judgement calls

### The out-of-order guard, which AGENTS.md says is owed

AGENTS.md: *"A retry topic reorders one key's events … the guard is an aggregate version on the
consumer's side, and it is owed the day a consumer applies two events whose order matters."*

This service has one: every write carries `version = occurred_at` in epoch milliseconds with
`version_type: external_gte`, so **the index itself refuses to go backwards** and no ordering
assumption is made about what Kafka hands us. A message that comes back off the retry topic five
minutes late loses to the newer one already indexed.

- `external_gte` and **not** `external`: `external` demands strictly greater, and two events about
  one show inside the same millisecond (a bulk publication, a fixture load) would see the second
  refused and its content lost. `external_gte` accepts an equal version, so a redelivery rewrites
  the same bytes and a same-millisecond pair applies in arrival order.
- The 409 that a stale write produces is read as **success** (`superseded`), not failure. Treating
  it as a failure would retry it, fail identically three times, and dead-letter a message whose
  effect is already correctly in place. The outcome reported is `applied`, because the index has
  converged to a state at least as new as this event.
- It earns its keep since 2026-09-26: `ShowUpdated` is projected, and date documents are
  versioned by the counter §0 describes.

### A 400 from OpenSearch is classified permanent

Everything else stays unclassified and therefore transient, per events.md's asymmetry. 400 is the
exception because the document is a pure function of the event: bytes a strict mapping rejects today
it rejects identically for ever. Left unclassified it would reach the dead-letter queue three
attempts later under reason `exhausted` — "a dependency never came back" — about a message that was
never going to work. `failure.spec.ts` is explicit that those two reasons mean opposite things.

**I wrote this comment before the code and it was false for about twenty minutes.** It is now true
and tested.

### `occurred_at` missing is a permanent error

Protobuf makes every field optional on the wire, so a message with no timestamp decodes happily and
would be projected at **version 0** — losing every conflict for ever, silently. There is no waiting
that adds a timestamp to bytes sent without one. Checked before the index write, so nothing is
written.

### The language-dependency codec

`show-consumer.ts` holds a `Record` from the protobuf enum to `@arthome/core`'s vocabulary.
**No string literal on either side** — both columns are imported members — so a member added to the
proto makes the `Record` incomplete and the build fails. That failure is the only thing that makes
the mapping admissible at all (code-conventions.md §5.2).

- `UNSPECIFIED` → `null`, not `none`. Protobuf's zero value is what an older producer sends when it
  has nothing to say; `none` would state as a fact that a show has no language barrier because
  nobody filled the field in.
- An **unknown** member → `null` (neutral), never a rejection — critical-rules.md §10. It is
  *dropped* rather than "kept raw", which is the one place this departs from core's `parseTolerant`:
  what arrives is an unnamed **integer**, not a string. Storing `9` as a keyword would put a term in
  the index that no filter can legitimately ask for and no surface can label. Both cases are tested.

### `show_projection` is a ledger, never a decision input

> **SUPERSEDED 2026-09-26 by §0**: it is now the read model the documents are composed from.

The handler never reads it. The authority on "which version is indexed" is OpenSearch's own
`_version`; a second copy consulted to decide would be two sources of truth, and the one nobody
watches wins. It exists for two things the index cannot do: reconciliation (a count here against the
index's document count is how a silently-lost index shows up), and **the trace link** —
`traceparent` is kept here and deliberately **not** put in the OpenSearch document, because a search
hit's `_source` is a product payload served to a client and trace context has no business
travelling there. There is a test asserting the traceparent is absent from the document.

Its upsert is **conditional** (`WHERE excluded.version >= show_projection.version`), so a stale
message that OpenSearch refused does not walk the ledger backwards. Raw SQL, because TypeORM's
`orUpdate` carries no condition on the DO UPDATE branch.

### The service name is `search`, and it is not a `Service`

`SERVICES` in `@arthome/core` has **seven** members and none of them is this one
(`src/vocabulary/people.ts`, the `SERVICES` declaration). That is correct and must stay: `SERVICES`
answers "which service does a BFF operation call", and a name in it that nothing calls makes every
upstream count wrong — exactly the mistake that constant was created to catch, where `realtime` was
declared as a service and anyone counting got eight out of seven. Nobody calls the search indexer.

So `SEARCH = 'search'` is a local constant in `main.ts`, and its **owning documents are outside my
tree**: `infra/kafka/topics.json` already declares `arthome.search.retry` and `arthome.search.dlq`,
and `infra/postgres/init-databases.sql` already creates the `search` database. **Risk:** the string
now appears in three places and `@arthome/core` owns none of them. If it is ever renamed, all three
must move together, and the symptom of getting it wrong is a consumer that will not start (KafkaJS
refuses a topic that does not exist) — loud, at least.

And it is emphatically **not** `catalog`: one consumer group per deployable, never one shared, or
the group leader assigns only its own topics and the others go unconsumed, silently (events.md
§1.4). The `catalog` service uses `catalog`; this one uses `search`.

### Smaller calls

- **`published_at`, not `occurred_at`.** A document ends up fed by more than one event, and
  `occurred_at` would then mean "whichever event touched it last" — not what a "newest shows" sort
  is asking for. The day `ShowUpdated` is projected, this field must **not** move (noted in the
  code).
- **`indexed_at` is the one field that is not a pure function of the event**, so a replay rewrites a
  document differing in exactly that field. Deliberate: without it, an index that stopped being fed
  looks exactly like an index that is up to date. It does not weaken §3 — the *searchable* content
  is still identical — but the "byte-identical on replay" claim is false, and the code says so.
- **Absent media is empty media, not a refusal.** A show published before its images were uploaded
  is still a show somebody must be able to find.
- **`ShowIndex` is a port, not the vendor `Client`.** Every decision worth asserting is made before
  any network call; a test that needed a container to reach them would be run rarely and therefore
  not at all.
- **Shutdown order**: consumers stop, then the producer, then the OpenSearch client, then the
  DataSource. Closing the database under a running handler turns a clean deploy into failed writes
  that retry and dead-letter — a deploy manufacturing the failures it was meant to avoid.
- **`ensureShowIndex` runs before the first message, not lazily.** Writing to a missing index
  auto-creates it with a mapping OpenSearch guesses from the first document, which is the single
  outcome `show-document.ts` exists to prevent.
- **No outbox table.** This service publishes nothing, so it needs no outbox, no replication slot
  and no connector. A slot created "for symmetry" and left unread retains the WAL until the disk is
  full.

---

## 5. Things I noticed **outside** my tree

1. **`libs/events/src/index.ts` — the blocker, and it resolved itself.** When I started, that file
   re-exported only `common` and `identity`, so `ShowPublishedSchema` was generated
   (`libs/events/src/gen/arthome/catalog/v1/events_pb.ts`) but unreachable through the package's
   `exports` map, and this service could not compile. I did **not** edit it. The **team lead**
   added `export * from './gen/arthome/catalog/v1/events_pb.js';` to that barrel and rebuilt
   `libs/events/dist` while I was working — they confirmed `ShowPublishedSchema`,
   `ShowUpdatedSchema` and `DateScheduledSchema` resolve. (I first assumed it was the `catalog`
   agent, since that service needs the same types to *produce* what I *consume*; the lead corrected
   the attribution. I never touched the file either way.) The comment now in that barrel flags the
   flat re-export as on borrowed time — the durable answer is one subpath per context, as
   `@arthome/contracts` already does, and the lead has said that restructuring is theirs after wave
   2. **Consequence today:** this service's module graph carries `identity`'s wire types too, which
   is the cost that comment predicts. I import from `@arthome-platform/events` and nowhere else —
   no shim, no deep path into `gen/`.

2. **`libs/events/dist` freshness is load-bearing for the test suite, and no gate covers it.**
   Vitest resolves `@arthome-platform/events` through the package's `default` condition
   (`dist/index.js`), not through `src` — `@arthome/source` is a TypeScript `customConditions`
   setting and Vite does not read it, and there is no vitest config anywhere in this repository
   adding it. (Inferred, not instrumented; the supporting facts are that there is no such config,
   and that my suite started passing only once `libs/events/dist/index.js` carried the catalog
   re-export at 09:50.) `pnpm run verify` runs `test` without building `libs/*` first, so a stale
   `dist` fails the tests of every consuming service with a confusing
   *"does not provide an export named …"*. A `build` step before `test` in `verify`, or a Vitest
   `resolve.conditions: ['@arthome/source']`, would close it.

3. **`isolatedDeclarations` is NOT on for apps — and if it were turned on, it would contradict
   ESLint on one line of mine. This is the arbitration you asked for.**

   *First, the fact.* `@arthome/tooling/tsconfig/lib.json` sets `isolatedDeclarations`; `app.json` —
   which `apps/search-indexer/tsconfig.json` extends — does not, and it is absent from
   `tsc --showConfig -p tsconfig.json`. Confirmed empirically as well: an exported function with no
   return annotation typechecks clean under the real config, and fails TS9007 the moment
   `--isolatedDeclarations` is passed. So explicit return types here are house convention, not a
   compiler gate. I wrote them on every exported function regardless.

   *Second, the conflict.* It is on `show-document.ts`, the `SHOW_INDEX_CONCRETE` line, and it is
   one construct: **an exported `const` initialised from a template literal.**

   ```ts
   export const SHOW_INDEX_CONCRETE = `${SHOW_INDEX_ALIAS}-v1`;          // TS9010 under --isolatedDeclarations
   export const SHOW_INDEX_CONCRETE: string = `${SHOW_INDEX_ALIAS}-v1`;  // @typescript-eslint/no-inferrable-types
   ```

   Both verified, in this tree, at this commit:

   - un-annotated + `tsc --noEmit --isolatedDeclarations --declaration` → `TS9010: Variable must
     have an explicit type annotation with --isolatedDeclarations`;
   - annotated + `eslint src --max-warnings 0` → `Type string trivially inferred from a string
     literal, remove type annotation`;
   - annotated + `--isolatedDeclarations` → **0 errors**. So the annotation is exactly what
     isolatedDeclarations wants and exactly what ESLint forbids.

   The nuance in the brief — "it does not demand a type on a `const` whose initialiser is a
   literal" — holds for a plain string literal (`SHOW_INDEX_ALIAS` is fine either way) and **does
   not hold for a template literal**, which TypeScript will not widen for a declaration file but
   which `no-inferrable-types` still calls "trivially inferred from a string literal".

   *What I did:* neither rule is silenced and there is no disable comment anywhere in this tree.
   The code is left in the form that compiles and lints clean under the **actual** configuration —
   un-annotated — which is correct today and is the one line that would have to change if
   `isolatedDeclarations` were ever extended to apps. **Yours to arbitrate.** The cheapest fix if
   you do extend it is `no-inferrable-types` configured with `ignoreProperties`/variable exemptions,
   or simply writing the constant as a plain literal rather than composing it.

4. **`compose.yaml`'s OpenSearch has no authentication and no TLS** (`DISABLE_SECURITY_PLUGIN`),
   which it documents as deliberate for development. `createOpenSearchClient` therefore takes only a
   node URL and passes no credentials. **Any real deployment needs credentials and TLS wired
   through there**, and that is a gap, not a decision.

5. **`@arthome-platform/config`'s `readEnv()` requires `PORT`** (`libs/config/src/env.ts`), which a
   consumer-only service has no use for. I did not call it — matching
   `apps/notifications/src/data-source.ts`, which also skips it. The dependency stays declared and
   unused in `apps/search-indexer/package.json`, exactly as it is in `apps/notifications/package.json`.
   Either `readEnv` should grow a variant for services with no HTTP port, or both manifests should
   drop the dependency.

6. **AGENTS.md's "Running the event path" runbook does not mention this service.** It needs a
   `pnpm --filter @arthome-platform/search-indexer run migration:run` beside the other two, and a
   note that OpenSearch must be healthy before the indexer starts. Not my file.

7. **`infra/kafka/topics.json` is complete for this service** — `arthome.catalog.show` (3
   partitions), `arthome.search.retry` and `arthome.search.dlq` are all declared. Nothing needed
   adding. Worth knowing that `provision:topics` must run before the indexer starts, for the same
   reason it must for `notifications`.

---

## 6. What a first live run must check, and what I did not do

Nothing here was exercised against the stack — `docker` was forbidden to me. In rough order of how
likely I am to be wrong:

1. **`ensureShowIndex` on an empty cluster.** That `indices.create` accepts the settings + mappings
   + aliases body as written, and that the alias is usable for writes immediately.
2. **`indices.exists` and the 404.** The opensearch-js client may return `{ body: false }` rather
   than throwing for a HEAD 404. The code handles both; only one of the two branches is right, and I
   could not find out which.
3. **`version_type: 'external_gte'` end to end.** Index a show, then replay an older `occurred_at`
   for the same show and confirm a 409 that this service reports as `applied` with the document
   unchanged and `show_projection.version` not moved.
4. **A strict-mapping rejection really is 400**, and reaches `arthome.search.dlq` with
   `arthome-dlq-reason: permanent` at `arthome-attempt: 0`.
5. **`number_of_replicas: 0`** — raise it before any real deployment. It is set to 0 because
   `compose.yaml` is single-node and an unassignable replica leaves the cluster yellow for ever,
   which teaches everyone that yellow is normal.

### Not done, on purpose

- ~~**No integration test.**~~ **DONE — `src/consumer/indexer.itest.ts`**, against a real
  OpenSearch and Postgres (§0). `pnpm run test:integration`; `verify` does not run it.
- ~~**`catalog.show.updated.v1` is not handled.**~~ **DONE** (§0): a partial update of the
  updatable group; `published_at` is never touched by it.
- ~~**`arthome.catalog.date` is not consumed.**~~ **DONE** (§0). **`arthome.catalog.artist` still
  is not**, and the date document carries no artist name.
- **Not in the date document yet, because no event carries them:** prices (ticketing), the venue's
  name, and the outcome (`DateOutcomeDeclared`, `DateRescheduled` are not consumed).
- **No percolator**, so `SavedSearchMatched` (the proto says it is raised by "the index's
  PERCOLATOR") has no producer. That is the other half of this service and it is not started.
- **`show_id` is an uuid column.** `ShowIdSchema` is `uuidV7()`, so that holds; but if `catalog`
  ever emits a non-uuid show id, the ledger insert fails as a *transient* error and takes three
  retries to reach the dead-letter queue, rather than being refused outright.
- **A `Timestamp` explicitly set to epoch 0** would produce `version: 0`, which OpenSearch may
  reject for external versioning. Not handled and not tested; an absent `occurred_at` is, which is
  the realistic case.
- **No metric or log beyond `onDisposition`.** Indexing lag — the gap between `published_at` and
  `indexed_at` — is the number this service should be judged by, and nothing computes it.
