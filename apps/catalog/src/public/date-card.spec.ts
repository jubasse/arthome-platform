import { describe, expect, it } from 'vitest';

import { DateCardSchema } from '@arthome/contracts/catalog';
import { DisplayState, PublicationState } from '@arthome/core';

import { dateCardOf } from './date-card.js';
import { publicDate } from './public-fixtures.js';

const BEFORE_THE_ROOM_OPENS = '2026-11-04T18:00:00.000Z';

describe('dateCardOf', () => {
  it('builds a card the published contract accepts', () => {
    const card = dateCardOf(publicDate(), BEFORE_THE_ROOM_OPENS);

    expect(DateCardSchema.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({
      title: 'Nuit blanche',
      slug: '2026-11-04',
      canonicalUrl: 'https://arthome.test/show/nuit-blanche/date/2026-11-04',
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
      publicDate({ publication_state: PublicationState.TECHNICAL }),
      '2026-11-04T19:10:00.000Z',
    );

    expect(card.displayState).toBe(DisplayState.ROOM_OPEN);
  });

  it('serves the title in its own language, and one slug whatever the language (D-075)', () => {
    const card = dateCardOf(publicDate({ title_fr: '' }), BEFORE_THE_ROOM_OPENS);

    expect(card).toMatchObject({ title: 'White night', slug: '2026-11-04' });
  });

  it('holds the state of a date fully over until an event, with no instant to re-run it at', () => {
    const card = dateCardOf(publicDate(), '2026-11-08T00:00:00.000Z');

    expect(card).toMatchObject({ displayState: DisplayState.ENDED, displayStateValidUntil: null });
    expect(DateCardSchema.safeParse(card).success).toBe(true);
  });
});
