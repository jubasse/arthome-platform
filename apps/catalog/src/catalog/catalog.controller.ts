import { parseTraceparent } from '@arthome-platform/http-edge';
import { Body, Controller, Header, HttpCode, Headers, Post } from '@nestjs/common';

import { rendition, type MediaSet, type Rendition } from '@arthome/core';

import { PublishShowSchema, type PublishShowBody } from './publish-show.schema.js';
import { PublishShowService } from './publish-show.service.js';

/**
 * The declared media, through the domain's own constructor.
 *
 * ⚠ THE SCHEMA CHECKED THE SHAPE, THIS CHECKS THE RULE, AND THE SPLIT IS
 *   critical-rules #2. `rendition()` already refuses an empty url and a non-integer
 *   or non-positive dimension, with `media.url_empty` and `media.size_invalid`.
 *   Writing `.url()` and `.positive()` into the schema too would be a second
 *   implementation of a rule the domain owns, and the two would drift the first time
 *   one was relaxed.
 *
 * ⚠ IT THROWS A `DomainError`, NOT AN `HttpException`, deliberately (rule 1).
 *   `ErrorEnvelopeFilter` maps it with no translation table, because a `DomainError`
 *   already carries `code`, `params` and `nature`.
 *
 * ⚠ IT STOPS AT THE FIRST BAD RENDITION, so a body with two bad images is told about
 *   one. Collecting would mean reimplementing its checks here — the duplication this
 *   function exists to avoid.
 */
function mediaSetOf(media: PublishShowBody['media']): MediaSet {
  const toRendition = (declared: { url: string; widthPx: number; heightPx: number }): Rendition =>
    rendition(declared.url, declared.widthPx, declared.heightPx);

  return {
    wide: media.wide.map(toRendition),
    poster: media.poster.map(toRendition),
  };
}

@Controller('shows')
export class CatalogController {
  public constructor(private readonly publishShow: PublishShowService) {}

  @Post()
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  public async publish(
    @Body({ schema: PublishShowSchema }) body: PublishShowBody,
    @Headers('traceparent') traceparent?: string,
  ): Promise<{ showId: string }> {
    // ⚠ THE `isMember` CHECK THAT WAS HERE IS GONE, NOT BECAUSE THE FIELD STOPPED
    //   MATTERING: it moved into `PublishShowSchema` as
    //   `vocabularyIn(LANGUAGE_DEPENDENCIES)`, the form this file's own comment named
    //   while saying zod was not a dependency. Every other field is checked for the
    //   first time — the asymmetry this controller used to defend was the Blocker.
    //
    // ⚠ THE HEADER IS STILL CHECKED BY HAND, because it cannot be otherwise:
    //   `@Headers` is `(property?: string) => ParameterDecorator` in the installed
    //   `@nestjs/common` 12.0.3, so it carries no `schema` and no pipe reaches it. A
    //   malformed one is dropped and the publication proceeds — decided.
    const trace = parseTraceparent(traceparent);

    const result = await this.publishShow.publish({
      channelId: body.channelId,
      artistId: body.artistId,
      categoryId: body.categoryId,
      genreIds: body.genreIds,
      tagIds: body.tagIds,
      runtimeMin: body.runtimeMin,
      languageDependency: body.languageDependency,
      spokenLanguages: body.spokenLanguages,
      subtitleLanguages: body.subtitleLanguages,
      surtitleLanguages: body.surtitleLanguages,
      media: mediaSetOf(body.media),
      traceparent: trace === null ? null : trace.traceparent,
    });

    // The show id IS returned, unlike identity's account id: `ShowPublished.show_id`
    // is published on `arthome.catalog.show` and is its partition key, so it is
    // already on the wire. `data-model.md` §7.1's opaque handles are for an account,
    // a profile and a person.
    return { showId: result.showId };
  }
}
