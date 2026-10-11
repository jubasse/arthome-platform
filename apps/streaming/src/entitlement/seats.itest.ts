import { SeatActivatedSchema, SeatCancelledSchema } from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SeatState } from '@arthome/core';

import { readEntitlementFacts } from './entitlement-facts.js';
import {
  DATE_SALES_TOPIC,
  nextMessageId,
  startProjection,
  wireMessage,
  type Projection,
  type WireMessage,
} from '../itest/entitlement.js';

/**
 * The seats, order-proof without instants (R11): every order of an activation, its cancellation, a
 *   duplicate and a retried older copy ends in the same row; the count and the lost seat per
 *   account and date; an empty account dead-lettered.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const NOW = '2026-10-10T10:00:00.000Z';
const ACTIVATED_AT = new Date('2026-10-01T10:00:00.000Z');
const CANCELLED_AT = new Date('2026-10-02T10:00:00.000Z');

let projection: Projection;

const idOf = (prefix: string, n: number): string =>
  `${prefix}-0000-7000-8000-${String(n).padStart(12, '0')}`;
const seatOf = (n: number): string => idOf('01a0f510', n);
const accountOf = (n: number): string => idOf('01a0f511', n);
const dateOf = (n: number): string => idOf('01a0f512', n);

function activated(
  seatId: string,
  accountId: string,
  dateId: string,
  messageId?: string,
): WireMessage {
  return wireMessage(
    DATE_SALES_TOPIC,
    'ticketing.seat.activated.v1',
    SeatActivatedSchema,
    dateId,
    { seatId, accountId, dateId, occurredAt: timestampFromDate(ACTIVATED_AT) },
    messageId,
  );
}

function cancelled(seatId: string, accountId: string, dateId: string): WireMessage {
  return wireMessage(DATE_SALES_TOPIC, 'ticketing.seat.cancelled.v1', SeatCancelledSchema, dateId, {
    seatId,
    accountId,
    dateId,
    occurredAt: timestampFromDate(CANCELLED_AT),
  });
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

async function seatRows(seatId: string): Promise<unknown[]> {
  return projection.dataSource.query(
    `SELECT account_id, date_id, state, occurred_at, applied_at
       FROM entitlement_seat WHERE seat_id = $1`,
    [seatId],
  );
}

beforeAll(async () => {
  projection = await startProjection('streaming_entitlement_seats_itest', new FixedClock(NOW), {
    startupTimeoutMs: STARTUP_MS,
  });
}, STARTUP_MS);

afterAll(async () => {
  await projection?.close();
});

describe('the seats of the entitlement projection', () => {
  it(
    'ends every order of activation, cancellation, duplicate and older copy in one cancelled row',
    async () => {
      const orders = permutations([
        'activation',
        'cancellation',
        'same message again',
        'older copy',
      ] as const);
      const rows = [];
      for (const [n, order] of orders.entries()) {
        const seat = seatOf(n + 1);
        const account = accountOf(1);
        const date = dateOf(1);
        const activationId = nextMessageId();
        const messages = {
          activation: activated(seat, account, date, activationId),
          cancellation: cancelled(seat, account, date),
          'same message again': activated(seat, account, date, activationId),
          'older copy': activated(seat, account, date),
        };
        for (const step of order) await projection.apply(messages[step]);
        rows.push(...(await seatRows(seat)));
      }

      expect(orders).toHaveLength(24);
      expect(rows).toHaveLength(24);
      expect(new Set(rows.map((row) => JSON.stringify(row))).size).toBe(1);
      expect(rows[0]).toEqual({
        account_id: accountOf(1),
        date_id: dateOf(1),
        state: SeatState.CANCELLED,
        occurred_at: CANCELLED_AT,
        applied_at: new Date(NOW),
      });
    },
    CASE_MS,
  );

  it(
    'answers each step: applied, duplicate, superseded once cancelled',
    async () => {
      const seat = seatOf(101);
      const activation = activated(seat, accountOf(2), dateOf(2));

      expect(await projection.apply(activation)).toBe(Outcome.APPLIED);
      expect(await projection.apply(activation)).toBe(Outcome.DUPLICATE);
      expect(await projection.apply(activated(seat, accountOf(2), dateOf(2)))).toBe(
        Outcome.SUPERSEDED,
      );
      expect(await projection.apply(cancelled(seat, accountOf(2), dateOf(2)))).toBe(
        Outcome.APPLIED,
      );
      expect(await projection.apply(cancelled(seat, accountOf(2), dateOf(2)))).toBe(
        Outcome.SUPERSEDED,
      );
      expect(await projection.apply(activated(seat, accountOf(2), dateOf(2)))).toBe(
        Outcome.SUPERSEDED,
      );
    },
    CASE_MS,
  );

  it(
    'counts the active seats per account and date, and the seat lost when none is left',
    async () => {
      const account = accountOf(3);
      const [two, lost, oneOfTwo] = [dateOf(31), dateOf(32), dateOf(33)];
      for (const message of [
        activated(seatOf(301), account, two),
        activated(seatOf(302), account, two),
        activated(seatOf(303), account, lost),
        cancelled(seatOf(303), account, lost),
        activated(seatOf(304), account, oneOfTwo),
        activated(seatOf(305), account, oneOfTwo),
        cancelled(seatOf(305), account, oneOfTwo),
        activated(seatOf(306), accountOf(4), two),
      ]) {
        expect(await projection.apply(message)).toBe(Outcome.APPLIED);
      }

      const standing = async (accountId: string, dateId: string): Promise<unknown> => {
        const facts = await readEntitlementFacts(projection.dataSource.manager, {
          accountId,
          dateId,
          now: NOW,
        });
        return { active: facts.activeSeatsOnDate, expired: facts.seatExpired };
      };
      expect(await standing(account, two)).toEqual({ active: 2, expired: false });
      expect(await standing(account, lost)).toEqual({ active: 0, expired: true });
      expect(await standing(account, oneOfTwo)).toEqual({ active: 1, expired: false });
      expect(await standing(accountOf(5), two)).toEqual({ active: 0, expired: false });
    },
    CASE_MS,
  );

  it(
    'ends the kept seat by its id when the cancellation states no account, date or instant',
    async () => {
      const seat = seatOf(501);
      const bare = (): WireMessage =>
        wireMessage(DATE_SALES_TOPIC, 'ticketing.seat.cancelled.v1', SeatCancelledSchema, seat, {
          seatId: seat,
        });

      await projection.apply(activated(seat, accountOf(6), dateOf(6)));
      expect(await projection.apply(bare())).toBe(Outcome.APPLIED);
      expect(await seatRows(seat)).toEqual([
        {
          account_id: accountOf(6),
          date_id: dateOf(6),
          state: SeatState.CANCELLED,
          occurred_at: ACTIVATED_AT,
          applied_at: new Date(NOW),
        },
      ]);
      expect(await projection.apply(bare())).toBe(Outcome.SUPERSEDED);
      const facts = await readEntitlementFacts(projection.dataSource.manager, {
        accountId: accountOf(6),
        dateId: dateOf(6),
        now: NOW,
      });
      expect({ active: facts.activeSeatsOnDate, expired: facts.seatExpired }).toEqual({
        active: 0,
        expired: true,
      });
    },
    CASE_MS,
  );

  it(
    'dead-letters a cancellation without an account only when no seat row exists',
    async () => {
      const seat = seatOf(502);

      await expect(
        projection.apply(
          wireMessage(DATE_SALES_TOPIC, 'ticketing.seat.cancelled.v1', SeatCancelledSchema, seat, {
            seatId: seat,
            accountId: '',
          }),
        ),
      ).rejects.toBeInstanceOf(PermanentError);
      expect(await seatRows(seat)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'dead-letters a seat with an empty account at once, writing nothing',
    async () => {
      const seat = seatOf(401);

      await expect(projection.apply(activated(seat, '', dateOf(4)))).rejects.toBeInstanceOf(
        PermanentError,
      );
      expect(await seatRows(seat)).toEqual([]);
    },
    CASE_MS,
  );
});
