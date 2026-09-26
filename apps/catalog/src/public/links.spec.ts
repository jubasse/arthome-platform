import { describe, expect, it } from 'vitest';

import { Locale } from '@arthome/core';

import { artistLanguageOf, artistUrl, publicLinkOf } from './links.js';
import { LinkKind } from './resolve-query.schema.js';
import { canonicalUrl } from '../dates/slug.js';

const origin = 'https://arthome.test';

describe('publicLinkOf', () => {
  it('reads back the page, language and slug the URL builders wrote', () => {
    expect(publicLinkOf(origin, canonicalUrl(origin, Locale.EN, 'white-night'))).toEqual({
      kind: LinkKind.DATE,
      language: Locale.EN,
      slug: 'white-night',
    });
    expect(publicLinkOf(origin, artistUrl(origin, Locale.FR, 'compagnie-verticale'))).toEqual({
      kind: LinkKind.ARTIST,
      language: Locale.FR,
      slug: 'compagnie-verticale',
    });
  });

  it('refuses another origin, another kind of page, a language not served', () => {
    for (const url of [
      'https://elsewhere.test/fr/d/nuit-blanche',
      `${origin}/fr/s/nuit-blanche`,
      `${origin}/de/d/nuit-blanche`,
      `${origin}/fr/d/nuit-blanche/extra`,
      'not a url',
    ]) {
      expect(publicLinkOf(origin, url)).toBeNull();
    }
  });
});

describe('artistLanguageOf', () => {
  it('is French unless the biography is only in English', () => {
    expect(artistLanguageOf([])).toBe(Locale.FR);
    expect(artistLanguageOf([{ contentLanguage: Locale.EN, text: 'A company.' }])).toBe(Locale.EN);
    expect(
      artistLanguageOf([
        { contentLanguage: Locale.EN, text: 'A company.' },
        { contentLanguage: Locale.FR, text: 'Une compagnie.' },
      ]),
    ).toBe(Locale.FR);
  });
});
