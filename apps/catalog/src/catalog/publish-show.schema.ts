import { z } from 'zod';

import { LANGUAGE_DEPENDENCIES } from '@arthome/core';
import { SlugSchema, vocabularyIn } from '@arthome/core/schema';

/**
 * ⚠ IT EXISTS BECAUSE `"genreIds": "abc"` INVENTED THREE GENRES NOBODY SENT.
 *   `publish-show.service.ts` spreads the value twice — into the event and into the
 *   row — and spreading a string yields its characters, so `['a','b','c']` was
 *   committed, published in `ShowPublished.genre_ids`, and indexed, with no error at
 *   any hop.
 *
 * ⚠ THE NUMERIC FIELDS WERE ACCIDENTALLY SAFE AND THE STRING FIELDS WERE NOT — the
 *   opposite of what HANDOVER.md used to say. `assertUInt32`
 *   (binary-encoding.js:692-702) throws on a negative, a non-integer and a non-number,
 *   and `toBinary` runs INSIDE the transaction, so `runtimeMin: -1` rolled back and
 *   published nothing. The writer's `string` (binary-encoding.js:241-245) does the
 *   reverse: `if (typeof value !== "string") { value = String(value); }`. The fields
 *   that needed guarding were the ones that looked least dangerous.
 *
 * ⚠ IT STAYS HERE AND NOT IN `@arthome/contracts`. That package is what the FRONTENDS
 *   consume; `POST /shows` is a BFF-to-service endpoint in no OpenAPI document. See
 *   HANDOVER.md — the obvious "DTOs live in contracts" move is wrong.
 */

/**
 * The `uint32` ceiling `ShowPublished.runtime_min` imposes (`events_pb.ts:144`), as
 * arithmetic rather than a number. A wire limit, not a domain constant
 * (critical-rules #15): above it `assertUInt32` throws inside the transaction — a 500
 * and a rollback where a 400 is owed.
 */
const UINT32_MAX = 2 ** 32 - 1;

/**
 * ⚠ SHAPE ONLY: THE RULE IS `@arthome/core`'s `rendition()` AND IS NOT RESTATED. It
 *   already refuses an empty url (`media.url_empty`) and a non-integer or non-positive
 *   dimension (`media.size_invalid`), both published codes. `.url()`, `.int()` or
 *   `.positive()` here would be a second implementation of a rule the domain owns —
 *   critical-rules #2 allows two calls and never two implementations.
 *
 * ⚠ `@arthome/contracts/catalog`'s `ImageRenditionSchema` IS NOT USED: this service
 *   does not depend on that package, and those are the BFFs' tolerant `Out` shapes
 *   while this is `In`.
 */
const RenditionIn = z.strictObject({
  url: z.string(),
  widthPx: z.number(),
  heightPx: z.number(),
});

export const PublishShowSchema = z.strictObject({
  /**
   * ⚠ SHAPE ONLY, AND `ChannelIdSchema` WAS CONSIDERED AND DECLINED. It and
   *   `ArtistIdSchema` are published UUIDv7 schemas — but these columns are `text`,
   *   nothing here fixes the format for this endpoint, and the fixtures in use are
   *   `channel-1`/`artist-1`. Pinning UUIDv7 would refuse, on a guess, bodies that work
   *   today. The wrong TYPE is the confirmed fault; the format is the BFF author's
   *   question.
   */
  channelId: z.string().min(1),
  artistId: z.string().min(1),

  /**
   * ⚠ `SlugSchema`, CHECKED AGAINST THE REAL IDS: core's taxonomy uses `music`,
   *   `stage`, `jazz`, `theatre`, `contemporary`, `ballet-classique`, `open-air` — all
   *   match. SHAPE strictness, not MEMBER: the taxonomy gains and loses members
   *   (critical-rules #10), so a list of them here would be a parallel table going
   *   stale. `findGenre` exists for the day a rule needs to resolve one.
   */
  categoryId: SlugSchema,

  /** PLURAL, per E9 and §2.6 — a show can be both `contemporary` and `repertoire`. */
  genreIds: z.array(SlugSchema),
  tagIds: z.array(SlugSchema),

  /** Bounded by what the wire carries: a maximum runtime is a domain rule and `@arthome/core` states none. */
  runtimeMin: z.int().min(0).max(UINT32_MAX),

  /**
   * ⚠ THE GUARD THAT WAS IN THE CONTROLLER, NOW IN THE FORM ITS AUTHOR NAMED — that
   *   comment said `vocabularyIn` was correct but "needs zod, which this service does
   *   not depend on". zod is a dependency now.
   *
   *   It is checked because it is a Protobuf ENUM: an unknown member has no number, so
   *   the silent outcome is `LANGUAGE_DEPENDENCY_UNSPECIFIED` — a published fact saying
   *   nothing about the field `hasLanguageBarrier` reads, with nothing anywhere
   *   failing. Member-strict because this is `In`.
   */
  languageDependency: vocabularyIn(LANGUAGE_DEPENDENCIES),

  /**
   * ⚠ BCP 47 AND NOT `LocaleIn`, WHICH WOULD CONFLATE TWO NOTIONS `show.entity.ts`
   *   separates: this is "what is PERFORMED — unrelated to the display locale
   *   (`LOCALES`)". `LOCALES` is `['fr','en']`, and a show performed in German is a real
   *   show. `@arthome/core` publishes no BCP 47 primitive, and inventing a language-tag
   *   regex in a service is what `available-surface.md` asks nobody to do.
   */
  spokenLanguages: z.array(z.string().min(1)),
  subtitleLanguages: z.array(z.string().min(1)),
  surtitleLanguages: z.array(z.string().min(1)),

  /** Both keys required: `MediaSet` declares both and the column is `NOT NULL`. */
  media: z.strictObject({
    wide: z.array(RenditionIn),
    poster: z.array(RenditionIn),
  }),
});

/**
 * An alias, never a class. It carries `languageDependency` already narrowed, which is
 * what lets `PublishShowCommand` keep its promise that "a raw string cannot reach
 * here" with no assertion.
 */
export type PublishShowBody = z.infer<typeof PublishShowSchema>;
