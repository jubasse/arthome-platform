import { describe, expect, it } from 'vitest';

import { Locale } from '@arthome/core';
import { SlugSchema } from '@arthome/core/schema';

import { canonicalUrl, slugCandidates, slugify } from './slug.js';

describe('slugify', () => {
  it('drops accents and ligatures and hyphenates the rest', () => {
    expect(slugify('Œdipe à Colone : la nuit')).toBe('oedipe-a-colone-la-nuit');
  });

  it('produces what SlugSchema accepts', () => {
    expect(SlugSchema.safeParse(slugify('  --Élan !! vital--  ')).success).toBe(true);
  });
});

describe('slugCandidates', () => {
  it('names the day at the venue, not in UTC', () => {
    const [base] = slugCandidates(
      { fr: 'Nuit blanche', en: '' },
      Locale.FR,
      '2026-11-04T23:30:00.000Z',
      'Europe/Paris',
      '01a0e100-0000-7000-8000-000000000001',
    );
    expect(base).toBe('nuit-blanche-2026-11-05');
  });

  it('falls back to the other language when a title has only one', () => {
    const [base] = slugCandidates(
      { fr: 'Nuit blanche', en: '' },
      Locale.EN,
      '2026-11-04T19:30:00.000Z',
      'Europe/Paris',
      '01a0e100-0000-7000-8000-000000000001',
    );
    expect(base).toBe('nuit-blanche-2026-11-04');
  });

  it('offers the venue time, then the id, for a second performance the same day', () => {
    expect(
      slugCandidates(
        { fr: 'Nuit blanche', en: '' },
        Locale.FR,
        '2026-11-04T19:30:00.000Z',
        'Europe/Paris',
        '01a0e100-0000-7000-8000-0000abcd1234',
      ).slice(1),
    ).toEqual(['nuit-blanche-2026-11-04-2030', 'nuit-blanche-2026-11-04-abcd1234']);
  });
});

describe('canonicalUrl', () => {
  it('matches the contract’s example shape', () => {
    expect(canonicalUrl('https://arthome.fr', Locale.FR, 'nuit-blanche-2026-09-21')).toBe(
      'https://arthome.fr/fr/d/nuit-blanche-2026-09-21',
    );
  });
});
