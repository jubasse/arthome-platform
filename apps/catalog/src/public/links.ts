import { Locale } from '@arthome/core';

import { LinkKind } from './resolve-query.schema.js';
import type { LocalizedCopy } from '../artists/artist.entity.js';

/** The short forms of data-model.md §2.7; a date has none, its URL already sits under its show. */
const SHORT_SHOW = 's';
const SHORT_ARTIST = 'a';

export type PublicLink =
  | { readonly kind: typeof LinkKind.SHOW; readonly slug: string }
  | { readonly kind: typeof LinkKind.DATE; readonly showSlug: string; readonly slug: string }
  | { readonly kind: typeof LinkKind.ARTIST; readonly slug: string };

export function showUrl(origin: string, showSlug: string): string {
  return `${origin}/${LinkKind.SHOW}/${showSlug}`;
}

export function dateUrl(origin: string, showSlug: string, dateSlug: string): string {
  return `${showUrl(origin, showSlug)}/${LinkKind.DATE}/${dateSlug}`;
}

export function artistUrl(origin: string, slug: string): string {
  return `${origin}/${LinkKind.ARTIST}/${slug}`;
}

/** The language an artist's page serves its biography in: French when it has French or none. */
export function biographyLanguageOf(biography: readonly LocalizedCopy[]): Locale {
  const languages = biography.map((copy) => copy.contentLanguage);
  return languages.length === 0 || languages.includes(Locale.FR) || !languages.includes(Locale.EN)
    ? Locale.FR
    : Locale.EN;
}

/** A page this origin issued a URL for, its short forms included; null for any other URL. */
export function publicLinkOf(origin: string, url: string): PublicLink | null {
  const parsed = URL.parse(url);
  if (parsed?.origin !== origin) return null;
  const segments = parsed.pathname.split('/').slice(1);
  if (segments.some((segment) => segment.length === 0)) return null;
  const [root, slug, child, childSlug, ...rest] = segments;
  if (slug === undefined || rest.length > 0) return null;
  if (root === LinkKind.SHOW || root === SHORT_SHOW) {
    if (child === undefined) return { kind: LinkKind.SHOW, slug };
    if (root === LinkKind.SHOW && child === LinkKind.DATE && childSlug !== undefined) {
      return { kind: LinkKind.DATE, showSlug: slug, slug: childSlug };
    }
    return null;
  }
  if ((root === LinkKind.ARTIST || root === SHORT_ARTIST) && child === undefined) {
    return { kind: LinkKind.ARTIST, slug };
  }
  return null;
}

/**
 * `kind` with `slug`, the contract's other form. A date's slug is unique only within its show, so
 *   for a date `slug` is `{show-slug}/{date-slug}`.
 */
export function kindLinkOf(kind: LinkKind, slug: string): PublicLink | null {
  if (kind !== LinkKind.DATE) return { kind, slug };
  const [showSlug, dateSlug, ...rest] = slug.split('/');
  if (showSlug === undefined || dateSlug === undefined || rest.length > 0) return null;
  return { kind, showSlug, slug: dateSlug };
}
