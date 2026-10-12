### The catalog date path

`catalog` runs two processes from `apps/catalog`: the API (`node dist/main.js`, on `PORT`) and the
consumer (`node dist/consumer.js`), which projects the checklist facts and, from `streaming.run.started.v1`
and `streaming.run.ended.v1`, takes a date `technical -> live -> ended`. A date goes from draft to published through the
studio's commands, each carrying an `Idempotency-Key`:

```
POST /venues                                  → venueId
POST /shows   (with title, synopsis, poster)  → showId
POST /channels/:channelId/dates               → 201, the date sheet, its publication in draft
POST /dates/:dateId/publication/transitions   { to, expectedVersion, acknowledgedPromiseCode }
POST /v1/dates/:dateId/outcome                { outcome, message, rescheduledTo, expectedVersion }
PATCH /v1/channels/:channelId/identity        { expectedVersion, publicName, slug, biography, categoryId }
```

Publishing answers `publication.checklist_incomplete` until ticketing, streaming and chat have
reported their four facts. Chat does not exist yet, and streaming's run desk (PS1) publishes its
facts only from a feed its in-process fake receives, which no development route drives; so in
development send the facts by hand on `arthome.ticketing.date_sales`,
`arthome.streaming.run` and `arthome.chat.date`, keyed by the date id, with a `message-id` and a
`type` header. A `streaming.run.started.v1` sent the same way on a date under technical check makes
its card `live`; `streaming.run.ended.v1` ends it and opens its `Replay`, which
`streaming.replay.asset_ready.v1` makes ready for the studio's `ended -> replay_online` (HANDOVER §0h).

Proven on the running stack on 2026-09-26:

| Check | Result |
| --- | --- |
| a replayed draft | `Idempotency-Replayed: true`, the body byte for byte, first `servedAt` included |
| the same key with another body | 409 `api.idempotency_key_reused` |
| a stale `expectedVersion` | 409 `state.conflict`, with the current state and version |
| publishing before the facts | 409 `publication.checklist_incomplete`, the four projected items named |
| publishing after them | on `arthome.catalog.date`, one partition, in order: `drafted`, two state changes, `date.scheduled` with the venue clock and canonical URL, `publication.engaged` |
| `search-indexer` running beside them | the date indexed in `arthome-catalog-date` with its show's titles and taxonomy and its venue's city; `nuit` finds `Les Nuits d’été` filtered on `marseille`; a show update and a move to `technical` each recompose it (version 1, 2, 3); a backlog from before the proto change indexed without errors |

The same run found two defects, both fixed and now held by tests: a draft served `…/d/undefined` as
its canonical URL, and a replay came back with its keys reordered, because `jsonb` reorders them.

An outcome was proven on the same stack on 2026-09-27, the indexer, catalog and the BFF running:

| Check | Result |
| --- | --- |
| postponing a published date to 15 December | 200; replayed under its key with `Idempotency-Replayed: true`; `outcome_declared` then `rescheduled` on the date's topic |
| its page through the BFF | `postponed` until 18:30 on 15 December, the new `startsAt` and `rescheduledTo` |
| the index and the search | the document moved to the new time with `outcome: postponed`; the show's group led by it |
| cancelling the other date | its page `cancelled` with no `displayStateValidUntil`, the index following |
| a second outcome; a draft; `postponed` without `rescheduledTo` | 409 naming `outcome`; 409 naming `state`; 400 naming `rescheduledTo` |
| the BFF giving up on a frozen index | 504 in 208 ms, and catalog still up |

That last row is a defect the run found: catalog crashed on the first abort, because its listener
returned the OpenSearch request, a thenable, and Node's `EventTarget` reports a listener's rejected
thenable as an uncaught exception. Fixed, and held by `search-catalog.handler.spec.ts`.

A channel's public face was proven the same way on 2026-09-27:

| Check | Result |
| --- | --- |
| creating it from version 0 | version 1 at the envelope's root, the slug from the name; replayed under its key |
| the channel's date pages, the index, a search for the artist's name | the artist named on the card at once; `artist_name` in the document once the indexer read `ArtistUpdated`; `q=port` finds the show (the first call after the start answered no groups, its body not captured) |
| the artist page through the BFF | 12 ms; the biography, the postponed date among the upcoming, the cancelled one among the past |
| `/fr/a/compagnie-du-port` resolved | the artist, its canonical URL |
| its slug from another channel; a stale edit | 409 `artist.slug_taken`; 409 `state.conflict` with the version |

The per-language URLs of the tables above were replaced the same day by arthome-core D-075 (no
language, `/show/…/date/…`, `/artist/…`, short `/s/` and `/a/`), and a date may now be postponed
three times (D-076). Proven on the stack above on 2026-09-27, `search-indexer` migrated before
catalog, the three processes running:

| Check | Result |
| --- | --- |
| the two migrations | show and date slugs backfilled (`nuits-blanches-a-marseille`, `2026-12-15`, `2026-12-19`); one `DateScheduled` restated per published date; the index documents rewritten with `show_slug`, `slug` and the new URL, nothing replayed by hand |
| search, the date page, `/show/…/date/…`, `/s/…`, `kind=date&slug={show}/{date}`, `/a/…` through the BFF | the new slug and canonical URL on the card and the page; each form resolved to its page, 10 to 15 ms |
| an old `/fr/d/…` URL | 404: never served outside development, not carried over |
| a second postponement | 200; the slug moved to `2026-12-22`, the old one aliased until 27 October and still resolving to the new URL; the index following |
| a third, a fourth, then a cancellation | 200; 409 `date.postponement_limit_reached` with `max: 3`; 200, the page `cancelled` at its last date |
| postponing the cancelled date | 409 `state.conflict` naming `outcome` |
| the artist's slug changed | the old `/a/…` resolving to `/artist/port`; the old slug refused to another channel, 409 `artist.slug_taken` |

Catalog moved to `@nestjs/cqrs` the same day (arthome-core D-084, D-085; the conventions are
`apps/catalog/HANDOVER.md` §0f). Proven on the stack above, the API, the checklist consumer, the
indexer and the BFF all built from that code, the facts sent on the three source topics by a
producer script:

| Check | Result |
| --- | --- |
| a draft, then the same key again | 201; replayed 201 with `Idempotency-Replayed: true` |
| the four checklist facts through Kafka | `applied` four times; the same `message-id` again, `duplicate` |
| facts about a date catalog does not hold | `dead-lettered` at once: attempt 0, reason `permanent`, "… is about date …, unknown here" |
| a `message-id` that is not a UUID | retried as transient on `arthome.catalog.retry`, since `processed_message.id` refuses it. Fixed since: `messageIdOf` in `libs/messaging` refuses it at every consumer's edge, dead-lettered at attempt 0, reason `permanent` |
| publishing | 200, version 2; slug `2027-03-10`, running time frozen at 110; on the date's key `drafted`, `state_changed`, `date.scheduled`, `engaged`; indexed; resolved through the BFF in 57 ms |
| postponing, then a stale command | 200, slug `2027-03-17`, the old one aliased; `outcome_declared` then `rescheduled`; 409 `state.conflict` with version 3 |
| the show retitled, the artist renamed | the old URL resolves to the new one, with the new title and the new name |
| SIGTERM to the consumer | both groups stopped, exit in 2.2 s, no connection left in `pg_stat_activity` |

The `TimeoutNegativeWarning` a KafkaJS client prints at start comes from KafkaJS 2.2.4 on Node 24:
a bare producer script prints it too.

