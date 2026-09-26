import { Locale } from '@arthome/core';

import { LinkKind } from './resolve-query.schema.js';
import type { LocalizedCopy } from '../artists/artist.entity.js';
import { DATE_SEGMENT } from '../dates/slug.js';

const ARTIST_SEGMENT = 'a';

const KIND_OF_SEGMENT: Readonly<Record<string, LinkKind>> = {
  [DATE_SEGMENT]: LinkKind.DATE,
  [ARTIST_SEGMENT]: LinkKind.ARTIST,
};

export interface PublicLink {
  readonly kind: LinkKind;
  readonly language: Locale;
  readonly slug: string;
}

/** data-model.md §2.7: French when the biography has French or nothing, English otherwise. */
export function artistLanguageOf(biography: readonly LocalizedCopy[]): Locale {
  const languages = biography.map((copy) => copy.contentLanguage);
  return languages.length === 0 || languages.includes(Locale.FR) || !languages.includes(Locale.EN)
    ? Locale.FR
    : Locale.EN;
}

export function artistUrl(origin: string, language: Locale, slug: string): string {
  return `${origin}/${language}/${ARTIST_SEGMENT}/${slug}`;
}

/** A page this origin issued a URL for, read back: null for any other URL. */
export function publicLinkOf(origin: string, url: string): PublicLink | null {
  const parsed = URL.parse(url);
  if (parsed?.origin !== origin) return null;
  const [, language, segment, slug, ...rest] = parsed.pathname.split('/');
  const kind = segment === undefined ? undefined : KIND_OF_SEGMENT[segment];
  if (kind === undefined || slug === undefined || slug.length === 0 || rest.length > 0) {
    return null;
  }
  if (language !== Locale.FR && language !== Locale.EN) return null;
  return { kind, language, slug };
}
