import { describe, expect, it } from 'vitest';

import { DateCardSchema } from '@arthome/contracts/catalog';
import {
  DateOutcome,
  DisplayState,
  PublicationState,
  ReplayPolicy,
  ReplayState,
  RunState,
} from '@arthome/core';

import { dateCardOf, runStateKnownFrom, type PublicDate } from './date-card.js';
import { publicDate } from './public-fixtures.js';

const BEFORE_THE_ROOM_OPENS = '2026-11-04T18:00:00.000Z';

describe('dateCardOf', () => {
  it('builds a card the published contract accepts', () => {
    const card = dateCardOf(publicDate(), BEFORE_THE_ROOM_OPENS);

    expect(DateCardSchema.safeParse(card).success).toBe(true);
    expect(card.replay).not.toHaveProperty('expiresAt');
    expect(card).toMatchObject({
      title: 'Nuit blanche',
      slug: '2026-11-04',
      canonicalUrl: 'https://arthome.test/show/nuit-blanche/date/2026-11-04',
      venueClock: { venueTimezone: 'Europe/Paris', venueUtcOffsetMin: 60 },
      roomOpensAt: '2026-11-04T19:00:00.000Z',
      displayState: DisplayState.SCHEDULED,
      displayStateValidUntil: '2026-11-04T19:00:00.000Z',
      replay: { policy: ReplayPolicy.INCLUDED, windowHours: 72 },
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
    const card = dateCardOf(
      publicDate({ publication_state: PublicationState.ENDED }),
      '2026-11-08T00:00:00.000Z',
    );

    expect(card).toMatchObject({ displayState: DisplayState.ENDED, displayStateValidUntil: null });
    expect(DateCardSchema.safeParse(card).success).toBe(true);
  });
});

describe('runStateKnownFrom', () => {
  it.each([
    [PublicationState.DRAFT, null],
    [PublicationState.RESERVE, null],
    [PublicationState.SCHEDULED, RunState.IDLE],
    [PublicationState.TECHNICAL, RunState.IDLE],
    [PublicationState.LIVE, RunState.ON_AIR],
    [PublicationState.ENDED, RunState.ENDED],
    [PublicationState.REPLAY_ONLINE, RunState.ENDED],
  ])('reads %s as %s', (state, run) => {
    expect(runStateKnownFrom(state)).toBe(run);
  });
});

describe('dateCardOf, from the run the publication records', () => {
  it('shows a date live from the on-air switch, before its start by the clock', () => {
    const card = dateCardOf(
      publicDate({ publication_state: PublicationState.LIVE }),
      BEFORE_THE_ROOM_OPENS,
    );

    expect(card.displayState).toBe(DisplayState.LIVE);
  });

  it('keeps a date room_open past its end while its run is known idle, until it moves', () => {
    const card = dateCardOf(publicDate(), '2026-11-08T00:00:00.000Z');

    expect(card.displayState).toBe(DisplayState.ROOM_OPEN);
  });

  it('shows a date ended once its run ended, whatever the clock says', () => {
    const card = dateCardOf(
      publicDate({ publication_state: PublicationState.ENDED }),
      '2026-11-04T19:40:00.000Z',
    );

    expect(card).toMatchObject({ displayState: DisplayState.ENDED, displayStateValidUntil: null });
  });

  it('keeps a known idle run past its start room_open until it is on air', () => {
    const card = dateCardOf(
      publicDate({ publication_state: PublicationState.TECHNICAL }),
      '2026-11-04T19:40:00.000Z',
    );

    expect(card.displayState).toBe(DisplayState.ROOM_OPEN);
  });
});

describe("dateCardOf, from the date's Replay", () => {
  const CLOSES_AT = '2026-11-07T21:40:00.000Z';
  const ONLINE_AT = '2026-11-04T22:15:00.000Z';
  const DURING_THE_WINDOW = '2026-11-05T10:00:00.000Z';

  function ended(replay: Partial<PublicDate>): PublicDate {
    return publicDate({
      publication_state: PublicationState.ENDED,
      replay_closes_at: CLOSES_AT,
      ...replay,
    });
  }

  const online = {
    publication_state: PublicationState.REPLAY_ONLINE,
    replay_state: ReplayState.ONLINE,
    replay_online_at: ONLINE_AT,
    replay_duration_sec: 5520,
  };

  it('shows a pending replay as ended, with no window', () => {
    const card = dateCardOf(ended({ replay_state: ReplayState.PENDING }), DURING_THE_WINDOW);

    expect(card).toMatchObject({ displayState: DisplayState.ENDED, displayStateValidUntil: null });
    expect(card.replay).toEqual({ policy: ReplayPolicy.INCLUDED, windowHours: 72 });
  });

  it('shows an online replay with its duration, its opening and its real closing', () => {
    const card = dateCardOf(ended(online), DURING_THE_WINDOW);

    expect(DateCardSchema.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({
      displayState: DisplayState.REPLAY,
      displayStateValidUntil: CLOSES_AT,
      replay: {
        policy: ReplayPolicy.INCLUDED,
        windowHours: 72,
        availableFrom: ONLINE_AT,
        expiresAt: CLOSES_AT,
        durationSec: 5520,
      },
    });
  });

  it('shows an online replay past its closing as ended, the sweeper not having run', () => {
    const card = dateCardOf(ended(online), CLOSES_AT);

    expect(card).toMatchObject({ displayState: DisplayState.ENDED, displayStateValidUntil: null });
  });

  it('serves the closing of a replay closed without going online, and no opening', () => {
    const card = dateCardOf(ended({ replay_state: ReplayState.CLOSED }), CLOSES_AT);

    expect(card.displayState).toBe(DisplayState.ENDED);
    expect(card.replay).toEqual({
      policy: ReplayPolicy.INCLUDED,
      windowHours: 72,
      expiresAt: CLOSES_AT,
    });
  });

  it('shows the outcome of a withdrawn replay, with no window', () => {
    const card = dateCardOf(
      publicDate({
        ...online,
        outcome: DateOutcome.INTERRUPTED,
        replay_state: ReplayState.WITHDRAWN,
        replay_closes_at: CLOSES_AT,
      }),
      DURING_THE_WINDOW,
    );

    expect(card.displayState).toBe(DisplayState.INTERRUPTED);
    expect(card.replay).toEqual({ policy: ReplayPolicy.INCLUDED, windowHours: 72 });
  });
});
