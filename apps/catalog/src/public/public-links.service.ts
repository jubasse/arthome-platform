import { PerishableResponse, schemaInvalidException } from '@arthome-platform/http-edge';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { Locale, type Clock } from '@arthome/core';

import { artistSummaryOf, type ArtistSummary } from './artist-page.js';
import { dateCardOf, type DateCard } from './date-card.js';
import { DateDetailPublic } from './date-detail-public.entity.js';
import { publicDateOfRow } from './date-detail.js';
import { artistLanguageOf, artistUrl, publicLinkOf, type PublicLink } from './links.js';
import { notFound } from './public-dates.service.js';
import { LinkKind, type ResolveQuery } from './resolve-query.schema.js';
import { Artist } from '../artists/artist.entity.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/** The current form, which may differ from the link followed: a slug in the other language. */
export type ResolvedLink =
  | {
      readonly kind: typeof LinkKind.DATE;
      readonly id: string;
      readonly canonicalUrl: string;
      readonly date: DateCard;
    }
  | {
      readonly kind: typeof LinkKind.ARTIST;
      readonly id: string;
      readonly canonicalUrl: string;
      readonly artist: ArtistSummary;
    };

@Injectable()
export class PublicLinksService {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public async resolve(query: ResolveQuery): Promise<PerishableResponse<ResolvedLink>> {
    const link = this.linkOf(query);
    if (link === null) throw notFound();
    return link.kind === LinkKind.ARTIST ? this.artist(link) : this.date(link);
  }

  private async date(link: PublicLink): Promise<PerishableResponse<ResolvedLink>> {
    const rows = await this.dataSource.manager.find(DateDetailPublic, {
      where: [{ slug_fr: link.slug }, { slug_en: link.slug }],
    });
    // Two dates can hold one slug, each in its own language: the link's language decides.
    const row =
      rows.find((candidate) =>
        link.language === Locale.EN
          ? candidate.slug_en === link.slug
          : candidate.slug_fr === link.slug,
      ) ?? rows[0];
    if (row === undefined) throw notFound();

    const date = dateCardOf(publicDateOfRow(row, this.publicWebOrigin), this.clock.now());
    return new PerishableResponse(
      { kind: LinkKind.DATE, id: row.date_id, canonicalUrl: date.canonicalUrl, date },
      date.displayStateValidUntil,
    );
  }

  private async artist(link: PublicLink): Promise<PerishableResponse<ResolvedLink>> {
    const artist = await this.dataSource.manager.findOneBy(Artist, { slug: link.slug });
    if (artist === null) throw notFound();
    const canonicalUrl = artistUrl(
      this.publicWebOrigin,
      artistLanguageOf(artist.biography),
      artist.slug,
    );
    return new PerishableResponse(
      { kind: LinkKind.ARTIST, id: artist.id, canonicalUrl, artist: artistSummaryOf(artist) },
      null,
    );
  }

  /** Either a URL or `kind` with `slug`, never both: the contract's "mutually exclusive". */
  private linkOf(query: ResolveQuery): PublicLink | null {
    const { url, kind, slug } = query;
    if (url !== undefined) {
      if (kind !== undefined || slug !== undefined) {
        throw schemaInvalidException([
          ...(kind === undefined ? [] : [{ path: ['kind'] }]),
          ...(slug === undefined ? [] : [{ path: ['slug'] }]),
        ]);
      }
      return publicLinkOf(this.publicWebOrigin, url);
    }
    if (kind === undefined || slug === undefined) {
      throw schemaInvalidException([{ path: [kind === undefined ? 'kind' : 'slug'] }]);
    }
    return { kind, language: Locale.FR, slug };
  }
}
