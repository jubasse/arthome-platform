import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ErrorEnvelopeFilter,
  RefusalException,
  SuccessEnvelopeInterceptor,
  schemaInvalidException,
} from '@arthome-platform/http-edge';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, HttpAdapterHost } from '@nestjs/core';
import { CqrsModule, QueryBus } from '@nestjs/cqrs';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { errors, type Client } from '@opensearch-project/opensearch';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiErrorCode, FixedClock } from '@arthome/core';

import { OPENSEARCH, SearchCatalogHandler } from './search-catalog.handler.js';
import { SearchCatalog } from './search-catalog.query.js';
import { SearchQuerySchema } from './search-query.schema.js';
import { SearchModule } from './search.module.js';
import { CLOCK } from '../clock.js';

const NOW = '2026-09-27T10:00:00.000Z';

/** A query that only ends when aborted, returning itself from `abort()` as the client does. */
function hangingQuery(onAbort: () => void): Promise<never> & { abort(): unknown } {
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, onRejected) => {
    reject = onRejected;
  });
  const query = Object.assign(pending, {
    abort: () => {
      onAbort();
      reject(new errors.RequestAbortedError('Request aborted', undefined));
      return query;
    },
  });
  return query;
}

/** An index whose every search hangs, keeping the options each was sent and counting aborts. */
function hangingIndex() {
  const sent: unknown[] = [];
  let aborted = 0;
  const client = {
    search: (_params: unknown, options: unknown) => {
      sent.push(options);
      return hangingQuery(() => {
        aborted += 1;
      });
    },
    close: () => Promise.resolve(),
  } as unknown as Client;
  return { client, sent, aborts: () => aborted };
}

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 2_000) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Records what reaches `uncaughtException` while `work` runs, and a little after. */
async function uncaughtDuring(work: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const record = (error: unknown): void => {
    uncaught.push(error);
  };
  process.on('uncaughtException', record);
  try {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('uncaughtException', record);
  }
  return uncaught;
}

let opened: TestingModule | INestApplication | null = null;

afterEach(async () => {
  await opened?.close();
  opened = null;
});

async function busOver(client: Client): Promise<QueryBus> {
  const moduleRef = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      SearchCatalogHandler,
      { provide: OPENSEARCH, useValue: client },
      { provide: CLOCK, useValue: new FixedClock(NOW) },
    ],
  }).compile();
  opened = moduleRef;
  // Handlers register with the buses when the module initialises.
  await moduleRef.init();
  return moduleRef.get(QueryBus);
}

describe('SearchCatalog', () => {
  it('stops the query when the caller leaves, and answers without an uncaught rejection', async () => {
    const { client } = hangingIndex();
    const queries = await busOver(client);
    let refusal: unknown;

    const uncaught = await uncaughtDuring(async () => {
      const caller = new AbortController();
      const search = queries.execute(
        new SearchCatalog(SearchQuerySchema.parse({ q: 'nuit' }), 1_000, caller.signal),
      );
      caller.abort();
      refusal = await search.catch((error: unknown) => error);
    });

    expect(refusal).toBeInstanceOf(RefusalException);
    expect((refusal as RefusalException).refusal.code).toBe(ApiErrorCode.DEADLINE_EXCEEDED);
    expect(uncaught).toEqual([]);
  });

  it('bounds the index request by the time the deadline leaves', async () => {
    const { client, sent } = hangingIndex();
    const queries = await busOver(client);
    const caller = new AbortController();

    const search = queries.execute(
      new SearchCatalog(SearchQuerySchema.parse({ q: 'nuit' }), 1_234, caller.signal),
    );
    caller.abort();
    await search.catch(() => undefined);

    expect(sent).toEqual([{ requestTimeout: 1_234 }]);
  });

  it('stops the query when the HTTP caller hangs up, from the controller through the bus', async () => {
    const index = hangingIndex();
    const clock = new FixedClock(NOW);
    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot(), SearchModule],
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
      .useValue(index.client)
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    opened = app;
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;

    const uncaught = await uncaughtDuring(async () => {
      const caller = request({
        host: '127.0.0.1',
        port,
        path: '/v1/search?q=nuit',
        headers: { 'x-arthome-deadline': '2026-09-27T10:01:00.000Z' },
      });
      caller.on('error', () => undefined);
      caller.end();
      await until(() => index.sent.length === 1);
      caller.destroy();
      await until(() => index.aborts() === 1);
    });

    expect(index.sent).toEqual([{ requestTimeout: 60_000 }]);
    expect(uncaught).toEqual([]);
  });
});
