import { z } from 'zod';

import { LANGUAGE_DEPENDENCIES } from '@arthome/core';
import { SlugSchema, vocabularyIn } from '@arthome/core/schema';

/**
 * Measured: `"genreIds": "abc"` published and indexed three genres nobody sent — the service
 *   spreads the value into event and row, and spreading a string yields its characters.
 * Measured: the numeric fields were already safe and the string ones were not —
 *   `assertUInt32` throws inside the transaction, while the writer's `string` coerces.
 * It stays here, not in `@arthome/contracts`: `POST /shows` is in no OpenAPI document.
 */

/**
 * The `uint32` ceiling `ShowPublished.runtime_min` imposes, as arithmetic. Above it
 * `assertUInt32` throws inside the transaction — a 500 and a rollback where a 400 is owed.
 */
const UINT32_MAX = 2 ** 32 - 1;

/**
 * Shape only: `@arthome/core`'s `rendition()` owns the rule and already refuses an empty
 *   url (`media.url_empty`) and a non-positive dimension (`media.size_invalid`). `.url()` or
 *   `.positive()` here would be a second implementation of it.
 */
/** An empty side is absent copy, not a fault: the publication checklist is what asks for it. */
const BilingualIn = z.strictObject({ fr: z.string(), en: z.string() });

const RenditionIn = z.strictObject({
  url: z.string(),
  widthPx: z.number(),
  heightPx: z.number(),
});

export const PublishShowSchema = z.strictObject({
  /**
   * `ChannelIdSchema` was declined: these columns are `text` and the fixtures in use are
   *   `channel-1`, so pinning UUIDv7 would refuse, on a guess, bodies that work today.
   */
  channelId: z.string().min(1),
  artistId: z.string().min(1),

  /** Shape, not membership: the taxonomy gains and loses members (critical-rules #10). */
  categoryId: SlugSchema,

  /** Plural per E9 and §2.6 — a show can be both `contemporary` and `repertoire`. */
  genreIds: z.array(SlugSchema),
  tagIds: z.array(SlugSchema),

  runtimeMin: z.int().min(0).max(UINT32_MAX),

  /**
   * Member-strict because it is a Protobuf enum: an unknown member has no number, so the
   *   silent outcome is `LANGUAGE_DEPENDENCY_UNSPECIFIED` — a published fact saying nothing
   *   about the field `hasLanguageBarrier` reads, with nothing failing anywhere.
   */
  languageDependency: vocabularyIn(LANGUAGE_DEPENDENCIES),

  /**
   * BCP 47, not `LocaleIn`: `LOCALES` is the display locale `['fr','en']`, and a show
   *   performed in German is a real show.
   */
  spokenLanguages: z.array(z.string().min(1)),
  subtitleLanguages: z.array(z.string().min(1)),
  surtitleLanguages: z.array(z.string().min(1)),

  media: z.strictObject({
    wide: z.array(RenditionIn),
    poster: z.array(RenditionIn),
  }),

  title: BilingualIn.default({ fr: '', en: '' }),
  synopsis: BilingualIn.default({ fr: '', en: '' }),
});

export type PublishShowBody = z.infer<typeof PublishShowSchema>;
