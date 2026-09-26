import { describe, expect, it } from 'vitest';

import { DateCardSchema } from '@arthome/contracts/catalog';
import { DisplayState, PublicationState } from '@arthome/core';

import { dateCardOf } from './date-card.js';
import { dateDocument } from './search-fixtures.js';

const BEFORE_THE_ROOM_OPENS = '2026-11-04T18:00:00.000Z';

describe('dateCardOf', () => {
  it('builds a card the published contract accepts', () => {
    const card = dateCardOf(dateDocument(), BEFORE_THE_ROOM_OPENS);

    expect(DateCardSchema.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({
      title: 'Nuit blanche',
      slug: 'nuit-blanche-2026-11-04',
      venueClock: { venueTimezone: 'Europe/Paris', venueUtcOffsetMin: 60 },
      roomOpensAt: '2026-11-04T19:00:00.000Z',
      displayState: DisplayState.SCHEDULED,
      displayStateValidUntil: '2026-11-04T19:00:00.000Z',
      replay: { expiresAt: '2026-11-07T21:05:00.000Z' },
      media: { wide: [{ url: 'https://cdn.arthome.test/w.jpg', widthPx: 1280, heightPx: 720 }] },
    });
  });

  it('shows a date under technical check on the time axis, as the public sees it', () => {
    const card = dateCardOf(
      dateDocument({ publication_state: PublicationState.TECHNICAL }),
      '2026-11-04T19:10:00.000Z',
    );

    expect(card.displayState).toBe(DisplayState.ROOM_OPEN);
  });

  it('serves the title and slug in the language the canonical URL uses', () => {
    const card = dateCardOf(dateDocument({ title_fr: '' }), BEFORE_THE_ROOM_OPENS);

    expect(card).toMatchObject({ title: 'White night', slug: 'white-night-2026-11-04' });
  });

  it('refuses to build a card for a date already over, which the query must have excluded', () => {
    expect(() => dateCardOf(dateDocument(), '2026-11-08T00:00:00.000Z')).toThrow(/ended/);
  });
});
