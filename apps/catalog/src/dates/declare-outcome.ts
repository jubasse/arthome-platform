import { DateOutcomeDeclaredSchema, DateRescheduledSchema } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import {
  DateOutcome,
  DomainConstant,
  assertOutcomeDeclarable,
  type Instant,
  type OutcomeDeclaration,
} from '@arthome/core';

import { asConflict } from './conflict.js';
import type { DeclareOutcomeBody } from './declare-outcome.schema.js';
import { freeDateSlug } from './free-date-slug.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { projectOutcome } from '../public/date-detail-projection.js';
import { dateUrl } from '../public/links.js';
import { LinkKind } from '../public/resolve-query.schema.js';
import { retireSlug } from '../public/slug-aliases.js';
import { venueClockAt } from '../venues/venue-clock.js';
import { WIRE_DATE_OUTCOME } from '../wire.js';
import type { DateRecords } from './date-sheet.js';

export interface DeclareOutcomeCommand extends DeclareOutcomeBody {
  readonly dateId: string;
  readonly traceparent: string | null;
}

export interface DeclaredOutcome {
  readonly outcome: DateOutcome;
  readonly declaredAt: Instant;
}

function declarationOf(command: DeclareOutcomeCommand): OutcomeDeclaration {
  if (command.outcome !== DateOutcome.POSTPONED)
    return { outcome: command.outcome, rescheduledTo: null };
  // The schema requires the instant for a postponement; a caller bypassing it is a defect.
  if (command.rescheduledTo === null) throw new Error('a postponement without rescheduledTo');
  return { outcome: DateOutcome.POSTPONED, rescheduledTo: command.rescheduledTo };
}

/**
 * The outcome, on a date whose publication version the caller already holds and bumped: one
 *   `DateOutcomeDeclared`, then, for a postponement, the date moved and `DateRescheduled` on the
 *   same key, so ticketing and notifications read them in that order (D-074). A move takes the
 *   new day's slug; the old one keeps resolving to the date for `SLUG_REDIRECT_DAYS` (D-075).
 */
export async function declareOutcomeIn(
  manager: EntityManager,
  records: DateRecords,
  command: DeclareOutcomeCommand,
  origin: string,
  now: Instant,
): Promise<DeclaredOutcome> {
  const { date, publication, show, venue } = records;
  const declaration = declarationOf(command);
  asConflict(() =>
    assertOutcomeDeclarable(
      {
        outcome: date.outcome,
        postponements: date.postponements,
        publicationState: publication.state,
        timing: {
          startsAt: date.starts_at.toISOString(),
          runtimeMin: date.runtime_min,
          roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
          replayPolicy: date.replay_policy,
          replayWindowHours: date.replay_window_hours ?? 0,
        },
      },
      declaration,
      now,
    ),
  );

  const declaredAt = new Date(now);
  const movedTo = declaration.rescheduledTo === null ? null : new Date(declaration.rescheduledTo);
  // A published date always holds a slug (announcePublication): the fallback only satisfies types.
  const previousSlug = date.slug ?? date.id;
  const movedSlug =
    movedTo === null
      ? previousSlug
      : await freeDateSlug(manager, date, movedTo.toISOString(), venue.time_zone, now);
  if (movedSlug !== previousSlug) {
    const key = { kind: LinkKind.DATE, scope: date.show_id, slug: previousSlug };
    await retireSlug(manager, key, date.id, now);
  }
  await manager.query(
    `UPDATE "date"
        SET outcome = $2, rescheduled_to = $3, outcome_declared_at = $4, outcome_message = $5,
            starts_at = COALESCE($3, starts_at), slug = $6,
            postponements = postponements + CASE WHEN $3::timestamptz IS NULL THEN 0 ELSE 1 END,
            updated_at = now()
      WHERE id = $1`,
    [date.id, declaration.outcome, movedTo, declaredAt, JSON.stringify(command.message), movedSlug],
  );
  await projectOutcome(
    manager,
    date.id,
    declaration.outcome,
    movedTo === null ? null : { startsAt: movedTo, slug: movedSlug },
  );

  await writeCatalogEvent(
    manager,
    {
      type: 'catalog.date.outcome_declared.v1',
      key: date.id,
      payload: toBinary(
        DateOutcomeDeclaredSchema,
        create(DateOutcomeDeclaredSchema, {
          dateId: date.id,
          channelId: date.channel_id,
          outcome: WIRE_DATE_OUTCOME[declaration.outcome],
          message: command.message,
          ...(movedTo !== null && { rescheduledTo: timestampFromDate(movedTo) }),
          declaredAt: timestampFromDate(declaredAt),
        }),
      ),
      traceparent: command.traceparent,
    },
    declaredAt,
  );
  if (movedTo !== null) {
    const venueClock = venueClockAt(venue.time_zone, movedTo.toISOString());
    await writeCatalogEvent(
      manager,
      {
        type: 'catalog.date.rescheduled.v1',
        key: date.id,
        payload: toBinary(
          DateRescheduledSchema,
          create(DateRescheduledSchema, {
            dateId: date.id,
            previousStartsAt: timestampFromDate(date.starts_at),
            newStartsAt: timestampFromDate(movedTo),
            newVenueClock: {
              venueTimezone: venueClock.timeZone,
              venueUtcOffsetMin: venueClock.utcOffsetMinutes,
            },
            newSlug: movedSlug,
            newCanonicalUrl: dateUrl(origin, show.slug, movedSlug),
            occurredAt: timestampFromDate(declaredAt),
          }),
        ),
        traceparent: command.traceparent,
      },
      declaredAt,
    );
  }
  return { outcome: declaration.outcome, declaredAt: declaredAt.toISOString() };
}
