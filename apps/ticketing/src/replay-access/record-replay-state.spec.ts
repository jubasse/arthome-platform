import {
  ReplayPolicy as WireReplayPolicy,
  ReplayState as WireReplayState,
} from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import type { CommandBus } from '@nestjs/cqrs';
import { describe, expect, it, vi } from 'vitest';

import {
  ApiErrorCode,
  DateOutcome,
  DomainError,
  ReplayPolicy,
  ReplayState,
  type Instant,
} from '@arthome/core';

import { RecordReplayState, type ReplayStateFact } from './record-replay-state.command.js';
import { nextReplayWindow, windowHoursOf, type ReplayWindow } from './replay-window.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import {
  REPLAY_CLOSES_AT,
  REPLAY_LIVE_ENDED_AT,
  delivered,
  replayStateChanged,
} from '../itest/catalog-messages.js';

const DATE_ID = '01a0f400-0000-7000-8000-000000000001';
const NOW = '2026-10-11T08:00:00.000Z';
const ONLINE_AT = '2026-10-11T06:00:00.000Z';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function fact(
  toState: ReplayState,
  version: number,
  policy: ReplayPolicy = ReplayPolicy.INCLUDED,
): ReplayStateFact {
  return {
    kind: 'replay_state',
    dateId: DATE_ID,
    version: BigInt(version),
    toState,
    policy,
    liveEndedAt: REPLAY_LIVE_ENDED_AT,
    closesAt: REPLAY_CLOSES_AT,
    onlineAt: toState === ReplayState.PENDING ? null : ONLINE_AT,
  };
}

function kept(
  state: ReplayState,
  version: number,
  marks: { grantedAt?: Instant; revokedAt?: Instant } = {},
): ReplayWindow {
  return {
    state,
    version: BigInt(version),
    policy: ReplayPolicy.INCLUDED,
    liveEndedAt: REPLAY_LIVE_ENDED_AT,
    closesAt: REPLAY_CLOSES_AT,
    onlineAt: null,
    grantedAt: marks.grantedAt ?? null,
    revokedAt: marks.revokedAt ?? null,
  };
}

const accessesOf = (change: ReturnType<typeof nextReplayWindow>) =>
  change.kind === 'kept' ? change.accesses : change.kind;

describe('the replay window', () => {
  it('keeps the newest version: a fact at or below the one kept is superseded', () => {
    const window = kept(ReplayState.ONLINE, 3, { grantedAt: NOW });

    expect(nextReplayWindow(window, fact(ReplayState.PENDING, 1), null, NOW)).toEqual({
      kind: 'superseded',
    });
    expect(nextReplayWindow(window, fact(ReplayState.ONLINE, 3), null, NOW)).toEqual({
      kind: 'superseded',
    });
    expect(nextReplayWindow(window, fact(ReplayState.CLOSED, 4), null, NOW)).toMatchObject({
      kind: 'kept',
      accesses: null,
      window: { state: ReplayState.CLOSED, version: 4n, onlineAt: ONLINE_AT, grantedAt: NOW },
    });
  });

  it('grants on a pending replay of an included date, and stamps the grant', () => {
    const change = nextReplayWindow(null, fact(ReplayState.PENDING, 1), null, NOW);

    expect(change).toMatchObject({ kind: 'kept', accesses: 'grant', window: { grantedAt: NOW } });
  });

  it.each([ReplayPolicy.UNIT, ReplayPolicy.SUBSCRIPTION, ReplayPolicy.NONE])(
    'grants nothing on a %s date',
    (policy) => {
      const change = nextReplayWindow(null, fact(ReplayState.PENDING, 1, policy), null, NOW);

      expect(change).toMatchObject({ kind: 'kept', accesses: null, window: { grantedAt: null } });
    },
  );

  it('grants nothing once an interruption or a cancellation is recorded, and grants after a postponement', () => {
    const pending = fact(ReplayState.PENDING, 1);

    expect(accessesOf(nextReplayWindow(null, pending, DateOutcome.INTERRUPTED, NOW))).toBeNull();
    expect(accessesOf(nextReplayWindow(null, pending, DateOutcome.CANCELLED, NOW))).toBeNull();
    expect(accessesOf(nextReplayWindow(null, pending, DateOutcome.POSTPONED, NOW))).toBe('grant');
  });

  it('grants nothing on a window of no hours', () => {
    const noHours = { ...fact(ReplayState.PENDING, 1), closesAt: REPLAY_LIVE_ENDED_AT };

    expect(windowHoursOf(REPLAY_LIVE_ENDED_AT, REPLAY_CLOSES_AT)).toBe(48);
    expect(accessesOf(nextReplayWindow(null, noHours, null, NOW))).toBeNull();
  });

  it('grants on a first-seen online replay, and not on a first-seen closed one', () => {
    expect(accessesOf(nextReplayWindow(null, fact(ReplayState.ONLINE, 2), null, NOW))).toBe(
      'grant',
    );
    expect(accessesOf(nextReplayWindow(null, fact(ReplayState.CLOSED, 3), null, NOW))).toBeNull();
  });

  it('grants once: an online or a closed replay after the grant changes the fields only', () => {
    const granted = kept(ReplayState.PENDING, 1, { grantedAt: NOW });

    expect(nextReplayWindow(granted, fact(ReplayState.ONLINE, 3), null, ONLINE_AT)).toMatchObject({
      kind: 'kept',
      accesses: null,
      window: { state: ReplayState.ONLINE, version: 3n, onlineAt: ONLINE_AT, grantedAt: NOW },
    });
    expect(
      accessesOf(nextReplayWindow(granted, fact(ReplayState.CLOSED, 4), null, NOW)),
    ).toBeNull();
  });

  it('revokes on a withdrawn replay, granted or not, and a later pending grants nothing', () => {
    const granted = kept(ReplayState.PENDING, 1, { grantedAt: ONLINE_AT });
    const withdrawn = nextReplayWindow(granted, fact(ReplayState.WITHDRAWN, 2), null, NOW);

    expect(withdrawn).toMatchObject({
      kind: 'kept',
      accesses: 'revoke',
      window: { state: ReplayState.WITHDRAWN, grantedAt: ONLINE_AT, revokedAt: NOW },
    });
    expect(
      nextReplayWindow(null, fact(ReplayState.WITHDRAWN, 2), DateOutcome.INTERRUPTED, NOW),
    ).toMatchObject({ kind: 'kept', accesses: 'revoke', window: { revokedAt: NOW } });
    expect(
      nextReplayWindow(
        kept(ReplayState.WITHDRAWN, 2, { revokedAt: NOW }),
        fact(ReplayState.PENDING, 1),
        null,
        NOW,
      ),
    ).toEqual({ kind: 'superseded' });
  });
});

describe('reading catalog.replay.state_changed.v1', () => {
  function commandsAnswering(answer: () => Promise<unknown>) {
    const execute = vi.fn((_command: unknown) => answer());
    return { commands: { execute } as unknown as CommandBus, execute };
  }

  it('dispatches RecordReplayState with the fact and its traceparent', async () => {
    const { commands, execute } = commandsAnswering(() => Promise.resolve(Outcome.APPLIED));
    const message = replayStateChanged(DATE_ID, {
      toState: WireReplayState.ONLINE,
      version: 2n,
      onlineAt: ONLINE_AT,
    });
    const traced = { ...message, headers: { ...message.headers, traceparent: TRACEPARENT } };

    expect(await applyCatalogDateMessage(commands, delivered(traced))).toBe(Outcome.APPLIED);
    const command = execute.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(RecordReplayState);
    expect(command).toMatchObject({ traceparent: TRACEPARENT, fact: fact(ReplayState.ONLINE, 2) });
  });

  it('ignores a state or a policy this build does not know', async () => {
    const { commands, execute } = commandsAnswering(() => Promise.resolve(Outcome.APPLIED));
    const unknownState = replayStateChanged(DATE_ID, {
      toState: 99 as WireReplayState,
      version: 1n,
    });
    const unspecifiedPolicy = replayStateChanged(DATE_ID, {
      toState: WireReplayState.PENDING,
      version: 1n,
      policy: WireReplayPolicy.UNSPECIFIED,
    });

    expect(await applyCatalogDateMessage(commands, delivered(unknownState))).toBe(Outcome.IGNORED);
    expect(await applyCatalogDateMessage(commands, delivered(unspecifiedPolicy))).toBe(
      Outcome.IGNORED,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('dead-letters a message with no closing, no version, or online with no online_at, and retries a date not opened here', async () => {
    const { commands, execute } = commandsAnswering(() =>
      Promise.reject(new DomainError({ code: ApiErrorCode.NOT_FOUND })),
    );
    const malformed = [
      replayStateChanged(DATE_ID, {
        toState: WireReplayState.PENDING,
        version: 1n,
        closesAt: null,
      }),
      replayStateChanged(DATE_ID, { toState: WireReplayState.PENDING, version: 0n }),
      replayStateChanged(DATE_ID, { toState: WireReplayState.ONLINE, version: 2n }),
    ];
    const pending = replayStateChanged(DATE_ID, { toState: WireReplayState.PENDING, version: 1n });

    for (const message of malformed) {
      await expect(applyCatalogDateMessage(commands, delivered(message))).rejects.toBeInstanceOf(
        PermanentError,
      );
    }
    expect(execute).not.toHaveBeenCalled();
    const retried = applyCatalogDateMessage(commands, delivered(pending));
    await expect(retried).rejects.toThrow(/not opened here yet/);
    await expect(retried).rejects.not.toBeInstanceOf(PermanentError);
  });
});
