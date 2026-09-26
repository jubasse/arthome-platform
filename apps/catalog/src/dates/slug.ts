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

/**
 * The slugs a date may take in one language, most readable first: the title and the day at
 * the venue, then the venue time for a second performance that day, then the date's own id.
 */
export function slugCandidates(
  title: Bilingual,
  language: Locale,
  startsAt: Instant,
  timeZone: string,
  dateId: string,
): string[] {
  const preferred = language === Locale.FR ? title.fr : title.en;
  const fallback = language === Locale.FR ? title.en : title.fr;
  const wall = wallClockAt(startsAt, venueClockAt(timeZone, startsAt).utcOffsetMinutes);
  const base = `${slugify(preferred.length > 0 ? preferred : fallback)}-${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
  return [base, `${base}-${pad(wall.hour)}${pad(wall.minute)}`, `${base}-${dateId.slice(-8)}`];
}

/** The URL a date is shared and indexed under, in its title's own language (§2.7). */
export function canonicalUrl(origin: string, language: Locale, slug: string): string {
  return `${origin}/${language}/d/${slug}`;
}

/** The language a date is shared and indexed under: its title's own, French when it has one. */
export function canonicalLanguageOf(title: Bilingual): Locale {
  return title.fr.length > 0 ? Locale.FR : Locale.EN;
}

/** A date's canonical URL once published; null before. */
export function canonicalUrlOf(
  origin: string,
  title: Bilingual,
  slugs: { readonly slug_fr: string | null; readonly slug_en: string | null },
): string | null {
  const language = canonicalLanguageOf(title);
  const slug = language === Locale.FR ? slugs.slug_fr : slugs.slug_en;
  return slug === null ? null : canonicalUrl(origin, language, slug);
}
