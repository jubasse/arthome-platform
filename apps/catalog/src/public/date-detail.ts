import type { z } from 'zod';

import type { DateDetailSchema } from '@arthome/contracts/catalog';
import type { StorefrontLocalizedTextSchema } from '@arthome/contracts/text';
import { Locale, isFullyOver, type Bilingual, type Instant } from '@arthome/core';

import {
  dateCardOf,
  earliestValidUntil,
  servedInFrench,
  timingOf,
  type DateCard,
  type PublicDate,
} from './date-card.js';
import type { DateDetailPublic } from './date-detail-public.entity.js';
import { canonicalUrlOf } from '../dates/slug.js';

export type DateDetail = z.output<typeof DateDetailSchema>;
type LocalizedText = z.output<typeof StorefrontLocalizedTextSchema>;

/** The page shows a handful; `totalSeriesDates` counts them all. */
const SERIES_DATES_MAX = 10;

export function publicDateOfRow(row: DateDetailPublic, origin: string): PublicDate {
  return {
    ...row,
    starts_at: row.starts_at.toISOString(),
    rights_scope: row.rights.scope,
    blackout_countries: row.rights.blackoutCountries,
    canonical_url: canonicalUrlOf(origin, row.title, row) ?? '',
    title_fr: row.title.fr,
    title_en: row.title.en,
  };
}

/** In the language the title is served in, or the other one when that side is empty. */
function synopsisOf(synopsis: Bilingual, french: boolean): LocalizedText | undefined {
  const preferred = {
    contentLanguage: french ? Locale.FR : Locale.EN,
    text: french ? synopsis.fr : synopsis.en,
  };
  const other = {
    contentLanguage: french ? Locale.EN : Locale.FR,
    text: french ? synopsis.en : synopsis.fr,
  };
  return [preferred, other].find((candidate) => candidate.text.length > 0);
}

/**
 * The page of `dateId`, from its show's public rows: its card, the show's copy, and the show's
 *   other dates not yet fully over, soonest first. Null when the date is not public.
 */
export function dateDetailOf(
  rows: readonly DateDetailPublic[],
  dateId: string,
  origin: string,
  now: Instant,
): { readonly detail: DateDetail; readonly validUntil: Instant | null } | null {
  const row = rows.find((candidate) => candidate.date_id === dateId);
  if (row === undefined) return null;

  const date = publicDateOfRow(row, origin);
  const card = dateCardOf(date, now);
  const series = rows
    .filter((other) => other.date_id !== dateId)
    .map((other) => publicDateOfRow(other, origin))
    .filter((other) => !isFullyOver(timingOf(other), now))
    .sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at));
  const seriesDates: DateCard[] = series
    .slice(0, SERIES_DATES_MAX)
    .map((other) => dateCardOf(other, now));
  const synopsis = synopsisOf(row.synopsis, servedInFrench(date));

  return {
    detail: {
      ...card,
      ...(synopsis !== undefined && { synopsis }),
      spokenLanguages: [...row.spoken_languages],
      subtitleLanguages: [...row.subtitle_languages],
      surtitleLanguages: [...row.surtitle_languages],
      seriesDates,
      totalSeriesDates: series.length,
    },
    validUntil: earliestValidUntil([card, ...seriesDates]),
  };
}
