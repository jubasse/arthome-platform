// ⚠ `@arthome-platform/events` IS A FLAT BARREL OVER THREE GENERATED CONTEXTS,
//   so `LanguageDependency` arrives here under the same name `@arthome/core`
//   uses for the domain vocabulary. Aliasing it is not cosmetic: the two are a
//   number and a string, and the whole point of the map below is that they are
//   never confused. The barrel is recorded as owed a per-context subpath in
//   `libs/events/src/index.ts` itself — the day a fourth context collides, this
//   import is one of the ones that breaks.
import {
  LanguageDependency as WireLanguageDependency,
  ShowPublishedSchema,
} from '@arthome-platform/events';
import { writeOutboxEvent } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LanguageDependency, type MediaSet } from '@arthome/core';

import { Show } from './show.entity.js';

export interface PublishShowCommand {
  readonly channelId: string;
  readonly artistId: string;
  readonly categoryId: string;
  readonly genreIds: readonly string[];
  readonly tagIds: readonly string[];
  readonly runtimeMin: number;
  /**
   * Already narrowed to a member of the vocabulary. The controller does that, and
   * the type is what records it: a raw string cannot reach here.
   */
  readonly languageDependency: LanguageDependency;
  readonly spokenLanguages: readonly string[];
  readonly subtitleLanguages: readonly string[];
  readonly surtitleLanguages: readonly string[];
  readonly media: MediaSet;
  /** W3C traceparent of the request that caused this, when there is one. */
  readonly traceparent: string | null;
}

export interface PublishedShow {
  readonly showId: string;
  readonly messageId: string;
}

/**
 * The domain's member → the wire's number.
 *
 * ⚠ THIS IS AN ENCODING, NOT A PARALLEL LITERAL TABLE, AND THE DIFFERENCE IS
 *   WORTH STATING because §5.2 forbids the second in almost these words: "a
 *   transform is the parallel literal table wearing a codec's costume". What it
 *   forbids is two live SPELLINGS of one value, with a function asserting they
 *   mean the same thing. Here there is one spelling — `@arthome/core`'s, which is
 *   also the wire's — and a Protobuf enum, which is a NUMBER on the wire whatever
 *   anyone would prefer. The number cannot be avoided; it can only be written
 *   once, here, from the two generated sides and never by hand.
 *
 *   Hence: no string literal on either side. The keys are computed from
 *   `@arthome/core`'s named members and the values are protobuf-es's generated
 *   enum, so neither spelling nor number is retyped.
 *
 * ⚠ `satisfies` IS THE EXHAUSTIVENESS CHECK, and it points at the domain on
 *   purpose. Adding a fourth member to `LANGUAGE_DEPENDENCIES` fails this build
 *   — which is what should happen, because the domain leads and the wire follows
 *   it. The reverse is deliberately NOT checked: the proto's `UNSPECIFIED = 0`
 *   has no domain member and must not acquire one.
 */
const WIRE_LANGUAGE_DEPENDENCY = {
  [LanguageDependency.NONE]: WireLanguageDependency.NONE,
  [LanguageDependency.HELPFUL]: WireLanguageDependency.HELPFUL,
  [LanguageDependency.ESSENTIAL]: WireLanguageDependency.ESSENTIAL,
} satisfies Record<LanguageDependency, WireLanguageDependency>;

@Injectable()
export class PublishShowService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Publish a show and record the fact, in ONE transaction.
   *
   * ⚠ THE TRANSACTION IS THE FEATURE. Never `save()` then `emit()`: a crash
   *   between the two loses the event, and a rollback after the emission invents
   *   one. Both writes go through the SAME `manager` — the one the transaction
   *   hands us — and neither is retried on its own.
   *
   * ⚠ `traceparent` IS INJECTED HERE, NOT WHEN THE MESSAGE IS PUBLISHED. The
   *   relay runs outside this request: by the time Debezium reads the row, the
   *   context that caused it no longer exists anywhere. Injected later, the link
   *   between the command and everything it causes is lost for good
   *   (events.md §1.3).
   */
  async publish(command: PublishShowCommand): Promise<PublishedShow> {
    const showId = uuidv7();
    const occurredAt = new Date();

    const event = create(ShowPublishedSchema, {
      showId,
      channelId: command.channelId,
      artistId: command.artistId,
      categoryId: command.categoryId,
      // Spread because the command's arrays are `readonly` and protobuf-es's
      // initialiser shape is not. Copying also means the message cannot alias a
      // caller's array and see it mutated after serialisation.
      genreIds: [...command.genreIds],
      tagIds: [...command.tagIds],
      runtimeMin: command.runtimeMin,
      languageDependency: WIRE_LANGUAGE_DEPENDENCY[command.languageDependency],
      spokenLanguages: [...command.spokenLanguages],
      subtitleLanguages: [...command.subtitleLanguages],
      surtitleLanguages: [...command.surtitleLanguages],
      // ⚠ NOT CONVERTED, AND THAT IS WHY `@arthome/core`'s `MediaSet` IS THE
      //   COMMAND'S TYPE RATHER THAN A SHAPE LOCAL TO THIS SERVICE. Core's
      //   `Rendition` and `arthome.common.v1.ImageRendition` agree field for
      //   field — `url`, `widthPx`, `heightPx` — so there is nothing to map, and a
      //   local shape would have manufactured something to map.
      media: { wide: [...command.media.wide], poster: [...command.media.poster] },
      occurredAt: timestampFromDate(occurredAt),
    });

    let messageId = '';
    await this.dataSource.transaction(async (manager) => {
      await manager.insert(Show, {
        id: showId,
        channel_id: command.channelId,
        artist_id: command.artistId,
        category_id: command.categoryId,
        genre_ids: [...command.genreIds],
        tag_ids: [...command.tagIds],
        runtime_min: command.runtimeMin,
        language_dependency: command.languageDependency,
        spoken_languages: [...command.spokenLanguages],
        subtitle_languages: [...command.subtitleLanguages],
        surtitle_languages: [...command.surtitleLanguages],
        media: command.media,
      });

      messageId = await writeOutboxEvent(
        manager,
        {
          // `catalog.show` → topic `arthome.catalog.show` (events.md §3).
          aggregateType: 'catalog.show',
          // The partition key. One show's events stay in order because of it, and
          // §3 fixes the key for this topic as `show_id`.
          aggregateId: showId,
          type: 'catalog.show.published.v1',
          // ⚠ Serialised HERE, by the producer. Debezium transports the bytes and
          //   reads none of them. The registry framing — magic byte, schema id,
          //   message indexes — belongs in front of these bytes and arrives with
          //   the schema registry; the path, key, headers and ordering do not
          //   depend on it.
          payload: toBinary(ShowPublishedSchema, event),
          traceparent: command.traceparent,
          // ⚠ NULL, AND IT IS A GAP RATHER THAN A PROPERTY OF THE FACT. Publishing
          //   a show is a studio act by a named operator — §2.3 keeps
          //   `last_actor_id` on the publication for exactly that, and the router
          //   maps this column to the `actor-id` header, so the studio journal is
          //   what goes without. It is null because this slice has no VERIFIED
          //   actor: token verification against the JWKS is not built here, and
          //   reading a name out of a request header is the `x-user-id`
          //   critical-rules #4 exists to forbid. An unverified actor in a journal
          //   that decides thousands of euros is worse than an absent one.
          //
          //   `ShowPublished` has no actor field of its own either, unlike
          //   `DateDrafted.drafted_by` — see HANDOVER.md.
          actorId: null,
        },
        occurredAt,
      );
    });

    return { showId, messageId };
  }
}
