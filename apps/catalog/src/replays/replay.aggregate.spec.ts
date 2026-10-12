import { describe, expect, it } from 'vitest';

import { CatalogErrorCode, ReplayPolicy, ReplayState, isDomainError } from '@arthome/core';

import { Replay, type ReplaySnapshot } from './replay.aggregate.js';
import { ReplayStateChanged } from './replay.events.js';

const LIVE_ENDED = '2026-11-04T21:40:00.000Z';
const CLOSES_AT = '2026-11-07T21:40:00.000Z';
const NOW = '2026-11-04T21:41:00.000Z';
const LATER = '2026-11-04T22:15:00.000Z';
const FILE = { durationSec: 5520, availableFrom: '2026-11-04T22:05:00.000Z' };

const OPENING = {
  dateId: 'date-1',
  channelId: 'channel-1',
  policy: ReplayPolicy.INCLUDED,
  liveEndedAt: LIVE_ENDED,
  windowHours: 72,
};

const PENDING: ReplaySnapshot = {
  dateId: 'date-1',
  channelId: 'channel-1',
  state: ReplayState.PENDING,
  policy: ReplayPolicy.INCLUDED,
  liveEndedAt: LIVE_ENDED,
  closesAt: CLOSES_AT,
  assetDurationSec: null,
  assetReadyAt: null,
  onlineAt: null,
  closedAt: null,
  withdrawnAt: null,
  version: 1,
};

const READY: ReplaySnapshot = {
  ...PENDING,
  assetDurationSec: FILE.durationSec,
  assetReadyAt: FILE.availableFrom,
  version: 2,
};

const ONLINE: ReplaySnapshot = { ...READY, state: ReplayState.ONLINE, onlineAt: LATER, version: 3 };

function refusalOf(decide: () => unknown): unknown {
  try {
    decide();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('Replay.open', () => {
  it('opens pending, closing at the real end plus the window, and says so from no state', () => {
    const replay = Replay.open(OPENING, NOW);

    expect(replay.snapshot).toEqual(PENDING);
    expect(replay.getUncommittedEvents()).toEqual([
      new ReplayStateChanged(
        'date-1',
        'channel-1',
        null,
        ReplayState.PENDING,
        1,
        ReplayPolicy.INCLUDED,
        LIVE_ENDED,
        CLOSES_AT,
        null,
        null,
        NOW,
      ),
    ]);
  });
});

describe('Replay.learnAssetReady', () => {
  it('records the file once, counting one version and publishing nothing', () => {
    const replay = Replay.restore(PENDING);

    expect(replay.learnAssetReady(FILE)).toBe(true);
    expect(replay.snapshot).toEqual(READY);
    expect(replay.getUncommittedEvents()).toEqual([]);
  });

  it('ignores a second file', () => {
    const replay = Replay.restore(READY);

    expect(replay.learnAssetReady({ durationSec: 1, availableFrom: LATER })).toBe(false);
    expect(replay.snapshot).toEqual(READY);
  });

  it.each([ReplayState.CLOSED, ReplayState.WITHDRAWN])('ignores a file on a %s replay', (state) => {
    const replay = Replay.restore({ ...PENDING, state });

    expect(replay.learnAssetReady(FILE)).toBe(false);
    expect(replay.snapshot.assetReadyAt).toBeNull();
  });
});

describe('Replay.goOnline', () => {
  it('goes online once its file is ready, carrying its opening and its duration', () => {
    const replay = Replay.restore(READY);

    replay.goOnline(LATER);

    expect(replay.snapshot).toEqual(ONLINE);
    expect(replay.getUncommittedEvents()).toEqual([
      new ReplayStateChanged(
        'date-1',
        'channel-1',
        ReplayState.PENDING,
        ReplayState.ONLINE,
        3,
        ReplayPolicy.INCLUDED,
        LIVE_ENDED,
        CLOSES_AT,
        LATER,
        5520,
        LATER,
      ),
    ]);
  });

  it('is refused while its file has not arrived', () => {
    const refusal = refusalOf(() => Replay.restore(PENDING).goOnline(LATER));

    expect(isDomainError(refusal) && refusal.code).toBe(CatalogErrorCode.REPLAY_ASSET_NOT_READY);
  });

  it.each([ReplayState.ONLINE, ReplayState.CLOSED, ReplayState.WITHDRAWN])(
    'is refused on a %s replay, naming its state',
    (state) => {
      const refusal = refusalOf(() => Replay.restore({ ...READY, state }).goOnline(LATER));

      expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
        CatalogErrorCode.REPLAY_UNAVAILABLE,
        { replayState: state },
      ]);
    },
  );

  it('is refused as closed past its closing, the sweeper not having run', () => {
    const replay = Replay.restore(READY);
    const refusal = refusalOf(() => replay.goOnline(CLOSES_AT));

    expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
      CatalogErrorCode.REPLAY_UNAVAILABLE,
      { replayState: ReplayState.CLOSED },
    ]);
    expect(replay.snapshot).toEqual(READY);
  });
});

describe('Replay.close and Replay.withdraw', () => {
  it('closes a pending replay without an opening or a duration', () => {
    const replay = Replay.restore(READY);

    expect(replay.close(CLOSES_AT)).toBe(true);

    expect(replay.snapshot).toEqual({
      ...READY,
      state: ReplayState.CLOSED,
      closedAt: CLOSES_AT,
      version: 3,
    });
    expect(replay.getUncommittedEvents()).toMatchObject([
      { from: ReplayState.PENDING, to: ReplayState.CLOSED, onlineAt: null, durationSec: null },
    ]);
  });

  it('withdraws an online replay, keeping its opening and its duration on the event', () => {
    const replay = Replay.restore(ONLINE);

    expect(replay.withdraw(NOW)).toBe(true);

    expect(replay.snapshot).toMatchObject({
      state: ReplayState.WITHDRAWN,
      withdrawnAt: NOW,
      onlineAt: LATER,
      version: 4,
    });
    expect(replay.getUncommittedEvents()).toEqual([
      new ReplayStateChanged(
        'date-1',
        'channel-1',
        ReplayState.ONLINE,
        ReplayState.WITHDRAWN,
        4,
        ReplayPolicy.INCLUDED,
        LIVE_ENDED,
        CLOSES_AT,
        LATER,
        5520,
        NOW,
      ),
    ]);
  });

  it.each([ReplayState.CLOSED, ReplayState.WITHDRAWN])(
    'leaves a %s replay as it is, with no event',
    (state) => {
      const closed = Replay.restore({ ...PENDING, state });
      const withdrawn = Replay.restore({ ...PENDING, state });

      expect([closed.close(NOW), withdrawn.withdraw(NOW)]).toEqual([false, false]);
      expect([...closed.getUncommittedEvents(), ...withdrawn.getUncommittedEvents()]).toEqual([]);
      expect(closed.snapshot.version).toBe(1);
    },
  );

  it('keeps its snapshot frozen', () => {
    const { snapshot } = Replay.restore(PENDING);

    expect(() => Object.assign(snapshot, { state: ReplayState.ONLINE })).toThrow(TypeError);
  });
});
