import { PerishableResponse, schemaInvalidException } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import type { Clock, Instant } from '@arthome/core';

import { artistSummaryOf } from './artist-page.js';
import { dateCardOf } from './date-card.js';
import { DateDetailPublic } from './date-detail-public.entity.js';
import { publicDateOfRow } from './date-detail.js';
import { artistUrl, kindLinkOf, publicLinkOf, showUrl, type PublicLink } from './links.js';
import { ResolvePublicLink, type ResolvedLink } from './resolve-public-link.query.js';
import { LinkKind, type ResolveQuery } from './resolve-query.schema.js';
import { UNSCOPED, aliasTargetOf } from './slug-aliases.js';
import { Artist } from '../artists/artist.entity.js';
import { Show } from '../catalog/show.entity.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { notFound } from '../refusals.js';

type LinkTo<K extends LinkKind> = Extract<PublicLink, { readonly kind: K }>;

@QueryHandler(ResolvePublicLink)
export class ResolvePublicLinkHandler implements IQueryHandler<ResolvePublicLink> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  /** A live slug first, then one replaced less than `SLUG_REDIRECT_DAYS` ago (D-075). */
  public async execute({ params }: ResolvePublicLink): Promise<PerishableResponse<ResolvedLink>> {
    const link = this.linkOf(params);
    if (link === null) throw notFound();
    const { manager } = this.dataSource;
    const now = this.clock.now();
    switch (link.kind) {
      case LinkKind.SHOW:
        return this.show(manager, link, now);
      case LinkKind.DATE:
        return this.date(manager, link, now);
      case LinkKind.ARTIST:
        return this.artist(manager, link, now);
    }
  }

  /** Public once one of its dates is. */
  private async show(
    manager: EntityManager,
    link: LinkTo<typeof LinkKind.SHOW>,
    now: Instant,
  ): Promise<PerishableResponse<ResolvedLink>> {
    const showId = await showIdOf(manager, link.slug, now);
    const row =
      showId === null ? null : await manager.findOneBy(DateDetailPublic, { show_id: showId });
    if (row === null) throw notFound();
    return new PerishableResponse(
      {
        kind: LinkKind.SHOW,
        id: row.show_id,
        canonicalUrl: showUrl(this.publicWebOrigin, row.show_slug),
      },
      null,
    );
  }

  private async date(
    manager: EntityManager,
    link: LinkTo<typeof LinkKind.DATE>,
    now: Instant,
  ): Promise<PerishableResponse<ResolvedLink>> {
    const showId = await showIdOf(manager, link.showSlug, now);
    if (showId === null) throw notFound();
    const live = await manager.findOneBy(DateDetailPublic, { show_id: showId, slug: link.slug });
    const target =
      live === null
        ? await aliasTargetOf(manager, { kind: LinkKind.DATE, scope: showId, slug: link.slug }, now)
        : null;
    const row =
      live ??
      (target === null ? null : await manager.findOneBy(DateDetailPublic, { date_id: target }));
    if (row === null) throw notFound();

    const date = dateCardOf(publicDateOfRow(row, this.publicWebOrigin), now);
    return new PerishableResponse(
      { kind: LinkKind.DATE, id: row.date_id, canonicalUrl: date.canonicalUrl, date },
      date.displayStateValidUntil,
    );
  }

  private async artist(
    manager: EntityManager,
    link: LinkTo<typeof LinkKind.ARTIST>,
    now: Instant,
  ): Promise<PerishableResponse<ResolvedLink>> {
    const live = await manager.findOneBy(Artist, { slug: link.slug });
    const target =
      live === null
        ? await aliasTargetOf(
            manager,
            { kind: LinkKind.ARTIST, scope: UNSCOPED, slug: link.slug },
            now,
          )
        : null;
    const artist =
      live ?? (target === null ? null : await manager.findOneBy(Artist, { id: target }));
    if (artist === null) throw notFound();
    return new PerishableResponse(
      {
        kind: LinkKind.ARTIST,
        id: artist.id,
        canonicalUrl: artistUrl(this.publicWebOrigin, artist.slug),
        artist: artistSummaryOf(artist),
      },
      null,
    );
  }

  /** Either a URL or `kind` with `slug`, never both: the contract's "mutually exclusive". */
  private linkOf(params: ResolveQuery): PublicLink | null {
    const { url, kind, slug } = params;
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
    return kindLinkOf(kind, slug);
  }
}

async function showIdOf(
  manager: EntityManager,
  slug: string,
  now: Instant,
): Promise<string | null> {
  const show = await manager.findOne(Show, { where: { slug }, select: { id: true } });
  return show?.id ?? aliasTargetOf(manager, { kind: LinkKind.SHOW, scope: UNSCOPED, slug }, now);
}
