import { parseTraceparent } from '@arthome-platform/http-edge';
import { Body, Controller, Header, HttpCode, Headers, Param, Patch, Post } from '@nestjs/common';

import { ShowIdSchema } from '@arthome/core/schema';

import { mediaSetOf } from './media.js';
import { PublishShowSchema, type PublishShowBody } from './publish-show.schema.js';
import { PublishShowService } from './publish-show.service.js';
import { UpdateShowSchema, type UpdateShowBody } from './update-show.schema.js';
import { UpdateShowService } from './update-show.service.js';

@Controller('shows')
export class CatalogController {
  public constructor(
    private readonly publishShow: PublishShowService,
    private readonly updateShow: UpdateShowService,
  ) {}

  @Post()
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  public async publish(
    @Body({ schema: PublishShowSchema }) body: PublishShowBody,
    @Headers('traceparent') traceparent?: string,
  ): Promise<{ showId: string }> {
    // By hand because no pipe reaches a header (see `traceparent.ts`). A malformed one is
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
      title: body.title,
      synopsis: body.synopsis,
      traceparent: trace === null ? null : trace.traceparent,
    });

    // Returned, unlike identity's account id: `show_id` is already on the wire as the
    // partition key of `arthome.catalog.show`. §7.1's opaque handles are for people.
    return { showId: result.showId };
  }

  @Patch(':showId')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public update(
    @Param('showId', { schema: ShowIdSchema }) showId: string,
    @Body({ schema: UpdateShowSchema }) body: UpdateShowBody,
    @Headers('traceparent') traceparent?: string,
  ): Promise<{ showId: string }> {
    const trace = parseTraceparent(traceparent);
    return this.updateShow.update({
      showId,
      ...(body.genreIds !== undefined && { genreIds: body.genreIds }),
      ...(body.tagIds !== undefined && { tagIds: body.tagIds }),
      ...(body.languageDependency !== undefined && { languageDependency: body.languageDependency }),
      ...(body.media !== undefined && { media: mediaSetOf(body.media) }),
      ...(body.title !== undefined && { title: body.title }),
      ...(body.synopsis !== undefined && { synopsis: body.synopsis }),
      traceparent: trace === null ? null : trace.traceparent,
    });
  }
}
