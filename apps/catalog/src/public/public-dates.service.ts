import {
  PerishableResponse,
  RefusalException,
  schemaInvalidException,
} from '@arthome-platform/http-edge';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { ApiErrorCode, FailureNature, Locale, type Clock } from '@arthome/core';

import { dateCardOf, type DateCard } from './date-card.js';
import { DateDetailPublic } from './date-detail-public.entity.js';
import { dateDetailOf, publicDateOfRow, type DateDetail } from './date-detail.js';
import { LinkKind, type ResolveQuery } from './resolve-query.schema.js';
import { CLOCK } from '../clock.js';
import { dateLinkOf } from '../dates/slug.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

export interface ResolvedLink {
  readonly kind: typeof LinkKind.DATE;
  readonly id: string;
  /** The current form, which may differ from the link followed: a slug in the other language. */
  readonly canonicalUrl: string;
  readonly date: DateCard;
}

/** api.not_found is "a route that does not resolve", which is exactly what a dead link is. */
function notFound(): RefusalException {
  return new RefusalException(HttpStatus.NOT_FOUND, {
    code: ApiErrorCode.NOT_FOUND,
    params: {},
    nature: FailureNature.REFUSED,
  });
}

@Injectable()
export class PublicDatesService {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  /** One query: the date's row and its show's other public rows. */
  public async detail(dateId: string): Promise<PerishableResponse<DateDetail>> {
    const rows = await this.dataSource.manager
      .createQueryBuilder(DateDetailPublic, 'row')
      .where('row.show_id = (SELECT show_id FROM date_detail_public WHERE date_id = :dateId)', {
        dateId,
      })
      .getMany();
    const page = dateDetailOf(rows, dateId, this.publicWebOrigin, this.clock.now());
    if (page === null) throw notFound();
    return new PerishableResponse(page.detail, page.validUntil);
  }

  public async resolve(query: ResolveQuery): Promise<PerishableResponse<ResolvedLink>> {
    const link = this.linkOf(query);
    if (link === null) throw notFound();
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

  /** Either a URL or `kind` with `slug`, never both: the contract's "mutually exclusive". */
  private linkOf(query: ResolveQuery): { readonly language: Locale; readonly slug: string } | null {
    const { url, kind, slug } = query;
    if (url !== undefined) {
      if (kind !== undefined || slug !== undefined) {
        throw schemaInvalidException([
          ...(kind === undefined ? [] : [{ path: ['kind'] }]),
          ...(slug === undefined ? [] : [{ path: ['slug'] }]),
        ]);
      }
      return dateLinkOf(this.publicWebOrigin, url);
    }
    if (kind === undefined || slug === undefined) {
      throw schemaInvalidException([{ path: [kind === undefined ? 'kind' : 'slug'] }]);
    }
    return { language: Locale.FR, slug };
  }
}
