import {
  ErrorEnvelopeFilter,
  SuccessEnvelopeInterceptor,
  schemaInvalidException,
} from '@arthome-platform/http-edge';
import {
  DATE_INDEX_ALIAS,
  DATE_INDEX_CONCRETE,
  DATE_INDEX_MAPPING,
  INDEX_SETTINGS,
} from '@arthome-platform/search-index';
import { startStack, type StartedStack } from '@arthome-platform/testing';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, HttpAdapterHost } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiErrorCode, DisplayState, FixedClock, ReplayPolicy } from '@arthome/core';

import type { ServableDateDocument } from './date-card.js';
import { dateDocument } from './search-fixtures.js';
import { SearchSort, SearchTab } from './search-query.schema.js';
import { SearchModule } from './search.module.js';
import { OPENSEARCH } from './search.service.js';
import { CLOCK } from '../clock.js';

/**
 * The search against a real OpenSearch, through the HTTP edge. What only a cluster proves:
 * `collapse` groups dates by show and counts what the filters kept, the french analyzer stems
 * the query, and the facets count shows.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

/** Nuit blanche's first date is in its replay window; Le Lac des cygnes is over. */
const NOW = '2026-11-05T12:00:00.000Z';

const SHOW_A = '01a0e500-0000-7000-8000-0000000000a1';
const SHOW_B = '01a0e500-0000-7000-8000-0000000000b1';
const SHOW_C = '01a0e500-0000-7000-8000-0000000000c1';
const SHOW_D = '01a0e500-0000-7000-8000-0000000000d1';

let stack: StartedStack;
let client: Client;
let app: NestFastifyApplication;

function addHours(instant: string, hours: number): string {
  return new Date(Date.parse(instant) + hours * 3_600_000).toISOString();
}

function date(
  dateId: string,
  showId: string,
  startsAt: string,
  overrides: Partial<ServableDateDocument> = {},
): ServableDateDocument {
  const runtimeMin = 95;
  const endsAt = addHours(startsAt, runtimeMin / 60);
  const replayHours = overrides.replay_policy === ReplayPolicy.NONE ? 0 : 72;
  return dateDocument({
    date_id: dateId,
    show_id: showId,
    starts_at: startsAt,
    runtime_min: runtimeMin,
    replay_window_hours: replayHours,
    ends_at: endsAt,
    over_at: addHours(endsAt, replayHours),
    ...overrides,
  });
}

const DATES: readonly ServableDateDocument[] = [
  date('01a0e500-0000-7000-8000-000000000a01', SHOW_A, '2026-11-04T19:30:00.000Z'),
  date('01a0e500-0000-7000-8000-000000000a02', SHOW_A, '2026-11-10T19:30:00.000Z'),
  date('01a0e500-0000-7000-8000-000000000a03', SHOW_A, '2026-11-20T19:30:00.000Z', {
    venue_country: 'BE',
  }),
  date('01a0e500-0000-7000-8000-000000000b01', SHOW_B, '2026-11-06T20:00:00.000Z', {
    title_fr: "Les Nuits d'été",
    title_en: 'Summer nights',
    category_id: 'music',
    genre_ids: ['opera'],
    replay_policy: ReplayPolicy.NONE,
  }),
  date('01a0e500-0000-7000-8000-000000000c01', SHOW_C, '2026-11-03T19:30:00.000Z', {
    title_fr: 'Le Lac des cygnes',
    category_id: 'dance',
    replay_policy: ReplayPolicy.NONE,
  }),
  // Its show has not reached the indexer yet: no title, no category, nothing to paint.
  date('01a0e500-0000-7000-8000-000000000d01', SHOW_D, '2026-11-08T19:30:00.000Z', {
    title_fr: '',
    title_en: '',
    category_id: null,
  }),
];

interface Envelope {
  readonly servedAt: string;
  readonly validUntil?: string;
  readonly groups: readonly {
    readonly showId: string;
    readonly matchingDatesCount: number;
    readonly representativeDate: { readonly id: string; readonly displayState: string };
  }[];
  readonly facets: readonly { readonly facetId: string; readonly values: unknown[] }[];
  readonly page: {
    readonly hasMore: boolean;
    readonly nextCursor?: string | null;
    readonly approximateTotal?: number;
  };
  readonly error?: { readonly code: string; readonly params: Record<string, unknown> };
}

const IN_A_SECOND = addHours(NOW, 1 / 3600);

async function search(
  query: Record<string, string | string[]>,
  deadline: string | null = IN_A_SECOND,
): Promise<{ readonly status: number; readonly body: Envelope }> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/search',
    query,
    headers: deadline === null ? {} : { 'x-arthome-deadline': deadline },
  });
  return { status: response.statusCode, body: response.json<Envelope>() };
}

const showIds = (body: Envelope): string[] => body.groups.map((group) => group.showId);

beforeAll(async () => {
  stack = await startStack({ opensearch: true, startupTimeoutMs: STARTUP_MS });
  client = new Client({ node: stack.opensearch.url, maxRetries: 0 });
  await client.indices.create({
    index: DATE_INDEX_CONCRETE,
    body: {
      settings: INDEX_SETTINGS,
      mappings: DATE_INDEX_MAPPING,
      aliases: { [DATE_INDEX_ALIAS]: {} },
    },
  });
  for (const document of DATES) {
    await client.index({ index: DATE_INDEX_ALIAS, id: document.date_id, body: document });
  }
  await client.indices.refresh({ index: DATE_INDEX_ALIAS });

  const clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [SearchModule],
    providers: [
      {
        provide: APP_PIPE,
        useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
      },
      {
        provide: APP_FILTER,
        inject: [HttpAdapterHost],
        useFactory: (host: HttpAdapterHost): ErrorEnvelopeFilter =>
          new ErrorEnvelopeFilter(host, clock),
      },
      { provide: APP_INTERCEPTOR, useValue: new SuccessEnvelopeInterceptor(clock) },
    ],
  })
    .overrideProvider(OPENSEARCH)
    .useValue(client)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('GET /v1/search against a real index', () => {
  it(
    'serves one group per show, soonest first, leaving out what is over or cannot be painted',
    async () => {
      const { status, body } = await search({ sort: SearchSort.SOON });

      expect(status).toBe(200);
      expect(showIds(body)).toEqual([SHOW_A, SHOW_B]);
      expect(body.groups[0]).toMatchObject({
        matchingDatesCount: 3,
        representativeDate: {
          id: '01a0e500-0000-7000-8000-000000000a01',
          displayState: DisplayState.REPLAY,
        },
      });
      expect(body.page).toMatchObject({ hasMore: false, approximateTotal: 2 });
      // Les Nuits d'été's room opens first: the envelope expires with that card.
      expect(body.validUntil).toBe('2026-11-06T19:30:00.000Z');
    },
    CASE_MS,
  );

  it(
    'finds both shows through the stemmed title, and counts facets in shows',
    async () => {
      const { body } = await search({ q: 'nuit' });

      expect(showIds(body).sort()).toEqual([SHOW_A, SHOW_B]);
      expect(body.facets).toContainEqual({
        facetId: 'category',
        values: expect.arrayContaining([
          { id: 'theatre', count: 1 },
          { id: 'music', count: 1 },
        ]) as unknown,
      });
    },
    CASE_MS,
  );

  it(
    'counts in a group only the dates the filters kept, and picks its representative among them',
    async () => {
      const lives = await search({ tab: SearchTab.LIVES, sort: SearchSort.SOON });
      const replays = await search({ tab: SearchTab.REPLAYS });
      const belgium = await search({ countryCodes: 'BE' });

      expect(lives.body.groups.find((group) => group.showId === SHOW_A)).toMatchObject({
        matchingDatesCount: 2,
        representativeDate: { id: '01a0e500-0000-7000-8000-000000000a02' },
      });
      expect(showIds(replays.body)).toEqual([SHOW_A]);
      expect(replays.body.groups[0]?.matchingDatesCount).toBe(1);
      expect(belgium.body.groups).toMatchObject([{ showId: SHOW_A, matchingDatesCount: 1 }]);
    },
    CASE_MS,
  );

  it(
    'pages over groups with the cursor it serves',
    async () => {
      const first = await search({ sort: SearchSort.SOON, limit: '1' });
      const second = await search({
        sort: SearchSort.SOON,
        limit: '1',
        cursor: first.body.page.nextCursor ?? '',
      });

      expect(showIds(first.body)).toEqual([SHOW_A]);
      expect(first.body.page.hasMore).toBe(true);
      expect(showIds(second.body)).toEqual([SHOW_B]);
      expect(second.body.page).toMatchObject({ hasMore: false, nextCursor: null });
    },
    CASE_MS,
  );
});

describe('GET /v1/search at the edge', () => {
  it(
    'refuses a call without a deadline, and one whose deadline has passed',
    async () => {
      const missing = await search({ q: 'nuit' }, null);
      const passed = await search({ q: 'nuit' }, NOW);

      expect(missing.status).toBe(400);
      expect(missing.body.error).toMatchObject({
        code: ApiErrorCode.SCHEMA_INVALID,
        params: { fields: ['x-arthome-deadline'] },
      });
      expect(passed.status).toBe(504);
      expect(passed.body.error?.code).toBe(ApiErrorCode.DEADLINE_EXCEEDED);
    },
    CASE_MS,
  );

  it(
    'names the criteria it does not serve instead of ignoring them',
    async () => {
      const { status, body } = await search({ q: 'nuit', priceMaxMinor: '2000', tab: 'artists' });

      expect(status).toBe(400);
      expect(body.error?.params).toEqual({ fields: ['priceMaxMinor', 'tab'] });
    },
    CASE_MS,
  );
});
