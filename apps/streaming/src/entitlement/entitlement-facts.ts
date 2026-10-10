import type { EntityManager } from 'typeorm';

import {
  DomainConstant,
  SeatState,
  planOpeningsOf,
  type DateOutcome,
  type DateTiming,
  type Instant,
  type PlanOpening,
  type BlackoutReason,
  type PublicationState,
  type ReplayPolicy,
  type RightsScope,
  type SubscriptionState,
  type TerritoryRights,
} from '@arthome/core';

/** What `streaming` holds about a date, each part null while the facts it needs are unknown. */
export interface DateFacts {
  readonly dateId: string;
  /** Null until a fact carrying it (scheduled, an outcome, a publication change) is applied. */
  readonly channelId: string | null;
  readonly timing: DateTiming | null;
  /** The raw publication state (D-072); null when unknown, or a member this build does not know. */
  readonly publicationState: PublicationState | null;
  readonly outcome: DateOutcome | null;
  readonly rights: TerritoryRights | null;
}

/** An account's standing on a date, in the terms `decideWatch`'s input takes. */
export interface EntitlementFacts {
  readonly activeSeatsOnDate: number;
  /** C2's lost seat: a seat of the account on the date cancelled, and none active. */
  readonly seatExpired: boolean;
  /** `planOpeningsOf` at `now`: nothing without a subscription. */
  readonly planOpenings: readonly PlanOpening[];
  readonly date: DateFacts | null;
}

export interface EntitlementQuery {
  readonly accountId: string;
  readonly dateId: string;
  readonly now: Instant;
}

interface DateRow {
  readonly date_id: string;
  readonly channel_id: string | null;
  readonly starts_at: Date | null;
  readonly runtime_min: number | null;
  readonly replay_policy: ReplayPolicy | null;
  readonly replay_window_hours: number | null;
  readonly rights_scope: RightsScope | null;
  readonly blackout_countries: string[] | null;
  readonly blackout_reason: BlackoutReason | null;
  readonly publication_state: PublicationState | null;
  readonly outcome: DateOutcome | null;
}

/** The date's columns come through a left join: all null, `date_id` too, without its row. */
interface EntitlementRow extends Omit<DateRow, 'date_id'> {
  readonly date_id: string | null;
  readonly active_seats: number;
  readonly cancelled_seats: number;
  readonly subscription_state: SubscriptionState | null;
  readonly openings: PlanOpening[] | null;
  readonly paid_through: Date | null;
}

const DATE_COLUMNS = `d.date_id, d.channel_id, d.starts_at, d.runtime_min, d.replay_policy,
       d.replay_window_hours, d.rights_scope, d.blackout_countries, d.blackout_reason,
       d.publication_state, d.outcome`;

export const READ_DATE_FACTS = `SELECT ${DATE_COLUMNS} FROM entitlement_date d WHERE d.date_id = $1`;

export const READ_ENTITLEMENT_FACTS = `
  SELECT seats.active_seats, seats.cancelled_seats,
         s.state AS subscription_state, s.openings, s.paid_through,
         ${DATE_COLUMNS}
    FROM (SELECT count(*) FILTER (WHERE state = '${SeatState.ACTIVE}')::int    AS active_seats,
                 count(*) FILTER (WHERE state = '${SeatState.CANCELLED}')::int AS cancelled_seats
            FROM entitlement_seat
           WHERE account_id = $1 AND date_id = $2) AS seats
    LEFT JOIN entitlement_subscription s ON s.account_id = $1
    LEFT JOIN entitlement_date d ON d.date_id = $2`;

function timingOf(row: DateRow): DateTiming | null {
  if (row.starts_at === null || row.runtime_min === null || row.replay_policy === null) {
    return null;
  }
  return {
    startsAt: row.starts_at.toISOString(),
    runtimeMin: row.runtime_min,
    roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
    replayPolicy: row.replay_policy,
    replayWindowHours: row.replay_window_hours ?? 0,
  };
}

function rightsOf(row: DateRow): TerritoryRights | null {
  if (row.rights_scope === null) return null;
  return {
    scope: row.rights_scope,
    blackoutCountries: row.blackout_countries ?? [],
    reason: row.blackout_reason,
  };
}

function dateFactsOf(row: DateRow): DateFacts {
  return {
    dateId: row.date_id,
    channelId: row.channel_id,
    timing: timingOf(row),
    publicationState: row.publication_state,
    outcome: row.outcome,
    rights: rightsOf(row),
  };
}

/** For PS1 (the on-air guard, the scheduled end) and PS5 (the replay policy, the outcome). */
export async function readDateFacts(
  manager: EntityManager,
  dateId: string,
): Promise<DateFacts | null> {
  const rows = await manager.query<DateRow[]>(READ_DATE_FACTS, [dateId]);
  const row = rows[0];
  return row === undefined ? null : dateFactsOf(row);
}

/** One statement on the caller's transaction, no lock: PS3 re-reads it at every renewal. */
export async function readEntitlementFacts(
  manager: EntityManager,
  { accountId, dateId, now }: EntitlementQuery,
): Promise<EntitlementFacts> {
  const rows = await manager.query<EntitlementRow[]>(READ_ENTITLEMENT_FACTS, [accountId, dateId]);
  const row = rows[0];
  if (row === undefined) throw new Error('the entitlement read answered no row');
  const state = row.subscription_state;
  return {
    activeSeatsOnDate: row.active_seats,
    seatExpired: row.cancelled_seats > 0 && row.active_seats === 0,
    planOpenings:
      state === null
        ? []
        : planOpeningsOf(
            {
              state,
              opens: row.openings ?? [],
              paidThrough: row.paid_through?.toISOString() ?? null,
            },
            now,
          ),
    date: row.date_id === null ? null : dateFactsOf({ ...row, date_id: row.date_id }),
  };
}
