import { parseTraceparent } from '@arthome-platform/http-edge';
import { Body, Controller, Header, HttpCode, Headers, Post } from '@nestjs/common';

import { rendition, type MediaSet, type Rendition } from '@arthome/core';

import { PublishShowSchema, type PublishShowBody } from './publish-show.schema.js';
import { PublishShowService } from './publish-show.service.js';

/**
 * ⚠ It throws a `DomainError`, not an `HttpException`: `ErrorEnvelopeFilter` maps it with no
 *   translation table, because a `DomainError` already carries `code`, `params` and `nature`.
 *   It stops at the first bad rendition — collecting would mean reimplementing its checks.
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
    // ⚠ By hand because no pipe reaches a header (see `traceparent.ts`). A malformed one is
    //   dropped and the publication proceeds — decided.
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

    // Returned, unlike identity's account id: `show_id` is already on the wire as the
    // partition key of `arthome.catalog.show`. §7.1's opaque handles are for people.
    return { showId: result.showId };
  }
}
