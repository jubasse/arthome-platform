import { DateDraftedSchema, PublicationStateChangedSchema } from '@arthome-platform/events';
import {
  RefusalException,
  schemaInvalidException,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import {
  DomainErrorCode,
  FailureNature,
  PublicationPromise,
  PublicationState,
  assertCommandedTransition,
  publicationReadiness,
  worldwideRights,
  type Clock,
  type ReplayPolicy,
} from '@arthome/core';

import { announcePublication } from './announce-publication.js';
import { asConflict, stateConflict } from './conflict.js';
import { dateRecordsOf } from './date-records.js';
import {
  dateSheet,
  publicationView,
  satisfiedChecklistItems,
  type DateSheet,
  type PublicationView,
} from './date-sheet.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import { PublicationRow } from './publication.entity.js';
import { Show } from '../catalog/show.entity.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { CLOCK } from '../clock.js';
import { runIdempotently, type IdempotentRequest } from '../idempotency/idempotency.js';
import { projectPublicationState } from '../public/date-detail-projection.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';
import { WIRE_PUBLICATION_STATE } from '../wire.js';

export interface DraftDateCommand {
  readonly channelId: string;
  readonly dateId: string;
  readonly showId: string;
  readonly venueId: string;
  readonly startsAt: string;
  readonly replayPolicy: ReplayPolicy;
  readonly replayWindowHours: number | null;
  readonly traceparent: string | null;
}

export interface TransitionPublicationCommand {
  readonly dateId: string;
  readonly to: PublicationState;
  readonly expectedVersion: number;
  readonly acknowledgedPromise: PublicationPromise | null;
  readonly traceparent: string | null;
}

@Injectable()
export class DatesService {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public draft(
    command: DraftDateCommand,
    idempotency: IdempotentRequest,
  ): Promise<MemorisedResponse<DateSheet>> {
    return this.dataSource.transaction((manager) =>
      runIdempotently(manager, idempotency, this.clock, () => this.draftIn(manager, command)),
    );
  }

  public transition(
    command: TransitionPublicationCommand,
    idempotency: IdempotentRequest,
  ): Promise<MemorisedResponse<PublicationView>> {
    return this.dataSource.transaction((manager) =>
      runIdempotently(manager, idempotency, this.clock, () => this.transitionIn(manager, command)),
    );
  }

  /**
   * The date and its publication in one transaction, by decision rather than by accident: the
   * contract creates a draft "with its publication and its checklist" (openapi/studio.yaml).
   */
  private async draftIn(manager: EntityManager, command: DraftDateCommand): Promise<DateSheet> {
    const show = await manager.findOneBy(Show, { id: command.showId });
    // Another channel's show is refused like a missing one: it is not this channel's to schedule.
    if (show?.channel_id !== command.channelId) {
      throw schemaInvalidException([{ path: ['showId'] }]);
    }
    const venue = await manager.findOneBy(Venue, { id: command.venueId });
    if (venue === null) throw schemaInvalidException([{ path: ['venueId'] }]);
    // A retry carries its Idempotency-Key and was replayed before this; the same id under a new
    // key is a client that reused an identifier.
    if (await manager.existsBy(PerformanceDateRow, { id: command.dateId })) {
      throw schemaInvalidException([{ path: ['dateId'] }]);
    }

    const occurredAt = new Date(this.clock.now());
    const date = manager.create(PerformanceDateRow, {
      id: command.dateId,
      show_id: show.id,
      venue_id: venue.id,
      channel_id: command.channelId,
      starts_at: new Date(command.startsAt),
      runtime_min: show.runtime_min,
      replay_policy: command.replayPolicy,
      replay_window_hours: command.replayWindowHours,
      rights: worldwideRights(),
      slug: null,
      postponements: 0,
    });
    await manager.insert(PerformanceDateRow, date);

    const publication = manager.create(PublicationRow, {
      date_id: command.dateId,
      channel_id: command.channelId,
      state: PublicationState.DRAFT,
      version: 1,
      published_at: null,
      prices_locked_at: null,
      replay_online_at: null,
    });
    await manager.insert(PublicationRow, publication);

    await writeCatalogEvent(
      manager,
      {
        type: 'catalog.date.drafted.v1',
        key: command.dateId,
        payload: toBinary(
          DateDraftedSchema,
          create(DateDraftedSchema, {
            dateId: command.dateId,
            channelId: command.channelId,
            showId: show.id,
            venueId: venue.id,
            occurredAt: timestampFromDate(occurredAt),
          }),
        ),
        traceparent: command.traceparent,
      },
      occurredAt,
    );

    return dateSheet({ date, publication, show, venue, projectedFacts: [] }, this.publicWebOrigin);
  }

  private async transitionIn(
    manager: EntityManager,
    command: TransitionPublicationCommand,
  ): Promise<PublicationView> {
    const records = await dateRecordsOf(manager, command.dateId);
    const { publication, show, projectedFacts } = records;
    const from = publication.state;
    const transition = asConflict(() =>
      assertCommandedTransition(
        { state: from, version: publication.version },
        {
          to: command.to,
          expectedVersion: command.expectedVersion,
          acknowledgedPromise: command.acknowledgedPromise,
        },
        true,
      ),
    );

    const satisfied = satisfiedChecklistItems(show, projectedFacts);
    // Publishing is the transition that engages the prices: `technical -> scheduled` also ends in
    // `scheduled` and is not one.
    const publishing = transition.irreversiblePromiseCode === PublicationPromise.PRICES_ENGAGED;
    if (publishing) {
      const readiness = publicationReadiness(satisfied);
      if (!readiness.ready) {
        throw new RefusalException(HttpStatus.CONFLICT, {
          code: DomainErrorCode.PUBLICATION_CHECKLIST_INCOMPLETE,
          params: { missing: readiness.missing },
          nature: FailureNature.REFUSED,
        });
      }
    }

    const occurredAt = new Date(this.clock.now());
    const next = manager.create(PublicationRow, {
      ...publication,
      state: command.to,
      version: publication.version + 1,
      published_at: publishing
        ? (publication.published_at ?? occurredAt)
        : publication.published_at,
      prices_locked_at: publishing
        ? (publication.prices_locked_at ?? occurredAt)
        : publication.prices_locked_at,
      replay_online_at:
        command.to === PublicationState.REPLAY_ONLINE ? occurredAt : publication.replay_online_at,
    });

    // Conditioned on the version read: a transition committed since then leaves this one
    // matching nothing, and it is refused like any stale screen.
    const [, updated] = await manager.query<[unknown, number]>(
      `UPDATE publication
          SET state = $3, version = $4, published_at = $5, prices_locked_at = $6,
              replay_online_at = $7, updated_at = now()
        WHERE date_id = $1 AND version = $2`,
      [
        publication.date_id,
        publication.version,
        next.state,
        next.version,
        next.published_at,
        next.prices_locked_at,
        next.replay_online_at,
      ],
    );
    if (updated !== 1) {
      const current = await manager.findOneByOrFail(PublicationRow, { date_id: command.dateId });
      throw stateConflict(current);
    }

    await projectPublicationState(manager, command.dateId, next.state);
    await writeCatalogEvent(
      manager,
      {
        type: 'catalog.publication.state_changed.v1',
        key: command.dateId,
        payload: toBinary(
          PublicationStateChangedSchema,
          create(PublicationStateChangedSchema, {
            dateId: command.dateId,
            channelId: publication.channel_id,
            fromState: WIRE_PUBLICATION_STATE[from],
            toState: WIRE_PUBLICATION_STATE[command.to],
            version: BigInt(next.version),
            irreversible: transition.irreversiblePromiseCode !== null,
            occurredAt: timestampFromDate(occurredAt),
          }),
        ),
        traceparent: command.traceparent,
      },
      occurredAt,
    );

    if (publishing) {
      await announcePublication(
        manager,
        records,
        next.state,
        this.publicWebOrigin,
        occurredAt,
        command.traceparent,
      );
    }

    return publicationView(next, satisfied);
  }
}
