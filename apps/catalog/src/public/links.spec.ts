import { describe, expect, it } from 'vitest';

import { Locale } from '@arthome/core';

import {
  artistUrl,
  biographyLanguageOf,
  dateUrl,
  kindLinkOf,
  publicLinkOf,
  showUrl,
} from './links.js';
import { LinkKind } from './resolve-query.schema.js';

const origin = 'https://arthome.test';

describe('publicLinkOf', () => {
  it('reads back the page the URL builders wrote, with no language in it (D-075)', () => {
    expect(publicLinkOf(origin, showUrl(origin, 'nuit-blanche'))).toEqual({
      kind: LinkKind.SHOW,
      slug: 'nuit-blanche',
    });
    expect(publicLinkOf(origin, dateUrl(origin, 'nuit-blanche', '2026-11-04'))).toEqual({
      kind: LinkKind.DATE,
      showSlug: 'nuit-blanche',
      slug: '2026-11-04',
    });
    expect(publicLinkOf(origin, artistUrl(origin, 'compagnie-verticale'))).toEqual({
      kind: LinkKind.ARTIST,
      slug: 'compagnie-verticale',
    });
  });

  it('reads the short forms of a show and an artist', () => {
    expect(publicLinkOf(origin, `${origin}/s/nuit-blanche`)).toEqual({
      kind: LinkKind.SHOW,
      slug: 'nuit-blanche',
    });
    expect(publicLinkOf(origin, `${origin}/a/compagnie-verticale`)).toEqual({
      kind: LinkKind.ARTIST,
      slug: 'compagnie-verticale',
    });
  });

  it('refuses another origin, another page, a third level, a short form with a date', () => {
    for (const url of [
      'https://elsewhere.test/show/nuit-blanche',
      `${origin}/fr/show/nuit-blanche`,
      `${origin}/show`,
      `${origin}/show/nuit-blanche/date`,
      `${origin}/show/nuit-blanche/date/2026-11-04/extra`,
      `${origin}/s/nuit-blanche/date/2026-11-04`,
      `${origin}/artist/compagnie-verticale/show/nuit-blanche`,
      `${origin}/show//date/2026-11-04`,
      'not a url',
    ]) {
      expect(publicLinkOf(origin, url)).toBeNull();
    }
  });
});

describe('kindLinkOf', () => {
  it('reads a date as {show-slug}/{date-slug}, its slug being unique only within its show', () => {
    expect(kindLinkOf(LinkKind.DATE, 'nuit-blanche/2026-11-04')).toEqual({
      kind: LinkKind.DATE,
      showSlug: 'nuit-blanche',
      slug: '2026-11-04',
    });
    expect(kindLinkOf(LinkKind.DATE, '2026-11-04')).toBeNull();
    expect(kindLinkOf(LinkKind.SHOW, 'nuit-blanche')).toEqual({
      kind: LinkKind.SHOW,
      slug: 'nuit-blanche',
    });
  });
});

describe('biographyLanguageOf', () => {
  it('is French unless the biography is only in English', () => {
    expect(biographyLanguageOf([])).toBe(Locale.FR);
    expect(biographyLanguageOf([{ contentLanguage: Locale.EN, text: 'A company.' }])).toBe(
      Locale.EN,
    );
    expect(
      biographyLanguageOf([
        { contentLanguage: Locale.EN, text: 'A company.' },
        { contentLanguage: Locale.FR, text: 'Une compagnie.' },
      ]),
    ).toBe(Locale.FR);
  });
});
