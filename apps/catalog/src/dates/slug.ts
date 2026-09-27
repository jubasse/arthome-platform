import { Locale, wallClockAt, type Bilingual, type Instant } from '@arthome/core';

import { venueClockAt } from '../venues/venue-clock.js';

const TITLE_SLUG_MAX = 60;

// Ligatures NFD leaves whole, and French titles carry them.
const LIGATURES: Readonly<Record<string, string>> = { œ: 'oe', æ: 'ae', ß: 'ss' };

/** Lowercase, hyphenated, no accent: the shape `SlugSchema` accepts. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[œæß]/g, (ligature) => LIGATURES[ligature] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TITLE_SLUG_MAX)
    .replace(/-+$/, '');
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The language a show's title, and so its slug, is read in: French when it has one. */
export function canonicalLanguageOf(title: Bilingual): Locale {
  return title.fr.length > 0 ? Locale.FR : Locale.EN;
}

/**
 * The slugs a show may take, most readable first: its title, then its title with its own id.
 *   A title too short for three characters leaves the id's tail alone.
 */
export function showSlugCandidates(title: Bilingual, showId: string): string[] {
  const base = slugify(canonicalLanguageOf(title) === Locale.FR ? title.fr : title.en);
  if (base.length < 3) return [showId.slice(-12)];
  return [base, `${base}-${showId.slice(-8)}`];
}

/**
 * The slugs a date may take within its show, most readable first: its day at the venue, then
 *   the venue time for a second performance that day, then the date's own id.
 */
export function dateSlugCandidates(startsAt: Instant, timeZone: string, dateId: string): string[] {
  const wall = wallClockAt(startsAt, venueClockAt(timeZone, startsAt).utcOffsetMinutes);
  const day = `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
  return [day, `${day}-${pad(wall.hour)}${pad(wall.minute)}`, `${day}-${dateId.slice(-8)}`];
}
