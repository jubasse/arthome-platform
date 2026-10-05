import { ErrorEnvelopeFilter } from '@arthome-platform/http-edge';
import type { ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { EventPublisher, type EventBus } from '@nestjs/cqrs';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';

import {
  DomainError,
  DomainErrorCode,
  FixedClock,
  PublicationState,
  ReplayPolicy,
  worldwideRights,
} from '@arthome/core';

import type { PerformanceDateRow } from './performance-date.entity.js';
import type { PublicationRow } from './publication.entity.js';
import { TransitionPublication } from './transition-publication.command.js';
import { TransitionPublicationHandler } from './transition-publication.handler.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { Venue } from '../venues/venue.entity.js';

const NOW = '2026-09-26T10:00:00.000Z';

const PUBLICATION: Omit<PublicationRow, 'updated_at'> = {
  date_id: 'date-1',
  channel_id: 'channel-1',
  state: PublicationState.DRAFT,
  version: 1,
  published_at: null,
  prices_locked_at: null,
  replay_online_at: null,
};

const DATE: Omit<PerformanceDateRow, 'created_at' | 'updated_at'> = {
  id: 'date-1',
  show_id: 'show-1',
  venue_id: 'venue-1',
  channel_id: 'channel-1',
  starts_at: new Date('2026-11-04T19:30:00.000Z'),
  runtime_min: 95,
  replay_policy: ReplayPolicy.INCLUDED,
  replay_window_hours: 72,
  rights: worldwideRights(),
  slug: '2026-11-04',
  postponements: 0,
  outcome: null,
  rescheduled_to: null,
  outcome_declared_at: null,
  outcome_message: null,
};

/** A transaction whose checklist facts come back as `facts` does: a list, or a failure. */
function handlerReading(facts: () => Promise<unknown[]>): TransitionPublicationHandler {
  const manager = {
    query: (sql: string) =>
      Promise.resolve(sql.includes('INSERT INTO idempotency_record') ? [{ key: 'claimed' }] : []),
    findOne: () => Promise.resolve(PUBLICATION),
    findOneOrFail: () =>
      Promise.resolve({
        id: 'show-1',
        runtime_min: 95,
        category_id: 'theatre',
        title: { fr: 'Nuit blanche', en: '' },
        synopsis: { fr: '', en: '' },
        media: { wide: [], poster: [] },
      }),
    findOneByOrFail: (entity: unknown) =>
      Promise.resolve(entity === Venue ? { id: 'venue-1', time_zone: 'Europe/Paris' } : DATE),
    findBy: facts,
  };
  const dataSource = {
    transaction: (work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
  } as unknown as DataSource;
  const bus = { publishAll: () => undefined } as unknown as EventBus;
  return new TransitionPublicationHandler(
    new CatalogTransactions(dataSource, new EventPublisher(bus)),
    new FixedClock(NOW),
    'https://arthome.test',
  );
}

const toReserveFrom = (expectedVersion: number) =>
  new TransitionPublication(
    'date-1',
    { to: PublicationState.RESERVE, expectedVersion, acknowledgedPromiseCode: null },
    null,
    { key: 'key-1', accountId: null, fingerprint: 'f', statusCode: 200 },
  );

/** The status the service's filter answers `error` with. */
function statusOf(error: unknown): number {
  let status = 0;
  const adapterHost = {
    httpAdapter: { reply: (_: unknown, __: unknown, answered: number) => (status = answered) },
  } as unknown as HttpAdapterHost;
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }), getResponse: () => ({}) }),
  } as unknown as ArgumentsHost;
  new ErrorEnvelopeFilter(adapterHost, new FixedClock(NOW)).catch(error, host);
  return status;
}

describe('TransitionPublicationHandler', () => {
  it('answers a refusal of the aggregate 409', async () => {
    const refusal = await handlerReading(() => Promise.resolve([]))
      .execute(toReserveFrom(3))
      .catch((error: unknown) => error);

    expect(statusOf(refusal)).toBe(409);
  });

  it('leaves any other domain error to the filter, at the status the registry gives its code', async () => {
    const invalid = new DomainError({ code: DomainErrorCode.CONTENT_EMPTY_IN_BOTH_LANGUAGES });
    const refusal = await handlerReading(() => Promise.reject(invalid))
      .execute(toReserveFrom(1))
      .catch((error: unknown) => error);

    expect(refusal).toBe(invalid);
    expect(statusOf(refusal)).toBe(500);
  });
});
