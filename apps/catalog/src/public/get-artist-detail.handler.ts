import { PerishableResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { artistPageOf, type ArtistDetail } from './artist-page.js';
import { DateDetailPublic } from './date-detail-public.entity.js';
import { GetArtistDetail } from './get-artist-detail.query.js';
import { notFound } from './not-found.js';
import { Artist } from '../artists/artist.entity.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

@QueryHandler(GetArtistDetail)
export class GetArtistDetailHandler implements IQueryHandler<GetArtistDetail> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  /** Two reads, no join: the artist, then its channel's public dates. */
  public async execute({ artistId }: GetArtistDetail): Promise<PerishableResponse<ArtistDetail>> {
    const artist = await this.dataSource.manager.findOneBy(Artist, { id: artistId });
    if (artist === null) throw notFound();
    const rows = await this.dataSource.manager.findBy(DateDetailPublic, {
      channel_id: artist.channel_id,
    });
    const { page, validUntil } = artistPageOf(artist, rows, this.publicWebOrigin, this.clock.now());
    return new PerishableResponse(page, validUntil);
  }
}
