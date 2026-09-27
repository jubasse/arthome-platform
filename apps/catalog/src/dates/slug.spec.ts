import { describe, expect, it } from 'vitest';

import { SlugSchema } from '@arthome/core/schema';

import { dateSlugCandidates, showSlugCandidates, slugify } from './slug.js';

describe('slugify', () => {
  it('drops accents and ligatures and hyphenates the rest', () => {
    expect(slugify('Œdipe à Colone : la nuit')).toBe('oedipe-a-colone-la-nuit');
  });

  it('produces what SlugSchema accepts', () => {
    expect(SlugSchema.safeParse(slugify('  --Élan !! vital--  ')).success).toBe(true);
  });
});

describe('showSlugCandidates', () => {
  it('reads the title in French when it has one, then adds the id for a namesake', () => {
    expect(
      showSlugCandidates(
        { fr: 'Nuit blanche', en: 'White night' },
        '01a0e100-0000-7000-8000-0000abcd1234',
      ),
    ).toEqual(['nuit-blanche', 'nuit-blanche-abcd1234']);
    expect(
      showSlugCandidates({ fr: '', en: 'White night' }, '01a0e100-0000-7000-8000-0000abcd1234')[0],
    ).toBe('white-night');
  });
});

describe('dateSlugCandidates', () => {
  it('names the day at the venue, not in UTC', () => {
    const [day] = dateSlugCandidates(
      '2026-11-04T23:30:00.000Z',
      'Europe/Paris',
      '01a0e100-0000-7000-8000-000000000001',
    );
    expect(day).toBe('2026-11-05');
  });

  it('offers the venue time, then the id, for a second performance the same day', () => {
    expect(
      dateSlugCandidates(
        '2026-11-04T19:30:00.000Z',
        'Europe/Paris',
        '01a0e100-0000-7000-8000-0000abcd1234',
      ).slice(1),
    ).toEqual(['2026-11-04-2030', '2026-11-04-abcd1234']);
  });
});
