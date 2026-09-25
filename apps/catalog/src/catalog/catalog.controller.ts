import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Post,
} from '@nestjs/common';

import { ApiErrorCode, FailureNature, LANGUAGE_DEPENDENCIES, isMember } from '@arthome/core';

import { PublishShowService } from './publish-show.service.js';

interface RenditionBody {
  url: string;
  widthPx: number;
  heightPx: number;
}

interface PublishShowBody {
  channelId: string;
  artistId: string;
  categoryId: string;
  genreIds: string[];
  tagIds: string[];
  runtimeMin: number;
  /** Raw, and narrowed below — a request can be wrong. */
  languageDependency: string;
  spokenLanguages: string[];
  subtitleLanguages: string[];
  surtitleLanguages: string[];
  media: { wide: RenditionBody[]; poster: RenditionBody[] };
}

@Controller('shows')
export class CatalogController {
  constructor(private readonly publishShow: PublishShowService) {}

  @Post()
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  async publish(
    @Body() body: PublishShowBody,
    @Headers('traceparent') traceparent?: string,
  ): Promise<{ showId: string }> {
    // ⚠ ONE FIELD IS CHECKED HERE AND THE OTHERS ARE NOT, AND THAT ASYMMETRY IS
    //   THE POINT. Identity lets `locale` and `country` through untouched, and it
    //   can afford to: they are text on the wire, so a wrong value arrives wrong
    //   and stays visible. `languageDependency` is a Protobuf ENUM. An unknown
    //   member has no number, so the silent outcome is
    //   `LANGUAGE_DEPENDENCY_UNSPECIFIED` — a published fact that says nothing
    //   about the one field a surface's most visible language rule reads, and
    //   nothing anywhere fails. That is the same class of fault the outbox's
    //   `payload_not_empty` CHECK exists to stop one level down, so it is stopped
    //   here, where a request is still waiting to be told.
    //
    // ⚠ STRICT, NOT TOLERANT, AND THE DIRECTION IS WHAT DECIDES. critical-rules
    //   #10 keeps an unknown member raw and neutral — that is the `Out` rule, for
    //   a client a year old reading a value it has never seen. This is `In`: a
    //   request can be wrong and is refused. `isMember` is the tool available
    //   here; `vocabularyIn` from `@arthome/core/schema` is the proper `In`
    //   strictness and needs zod, which this service does not depend on. The
    //   boundary DTO that would do this once for every caller belongs in
    //   `@arthome/contracts/catalog` — see HANDOVER.md.
    if (!isMember(LANGUAGE_DEPENDENCIES, body.languageDependency)) {
      // A code and its params, never a sentence (critical-rules #8). `traceId`
      // and the single error envelope shape are owed and are NOT built here:
      // identity has no error path to mirror, and the envelope belongs to
      // `@arthome/contracts/envelope`.
      throw new BadRequestException({
        code: ApiErrorCode.SCHEMA_INVALID,
        params: { field: 'languageDependency' },
        nature: FailureNature.REFUSED,
      });
    }

    // ⚠ The incoming traceparent is taken as given and carried through. It is
    //   not validated here because a malformed one must not fail a publication:
    //   a broken trace is an observability fault, never a business one.
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
      media: body.media,
      traceparent: traceparent ?? null,
    });
    return { showId: result.showId };
  }
}
