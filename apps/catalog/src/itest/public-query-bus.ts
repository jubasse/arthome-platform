import { CqrsModule, QueryBus, type Query } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { CLOCK } from '../clock.js';
import { GetArtistDetailHandler } from '../public/get-artist-detail.handler.js';
import { GetDateDetailHandler } from '../public/get-date-detail.handler.js';
import { ResolvePublicLinkHandler } from '../public/resolve-public-link.handler.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * A real `QueryBus` holding the public read handlers, at `clock`'s time. Each `execute` boots and
 *   closes its own module, so a suite builds one per instant with nothing left to close.
 */
export function publicQueryBus(
  dataSource: DataSource,
  clock: Clock,
  origin: string,
): { execute<R>(query: Query<R>): Promise<R> } {
  return {
    async execute<R>(query: Query<R>): Promise<R> {
      const moduleRef = await Test.createTestingModule({
        imports: [CqrsModule.forRoot()],
        providers: [
          GetDateDetailHandler,
          GetArtistDetailHandler,
          ResolvePublicLinkHandler,
          { provide: DataSource, useValue: dataSource },
          { provide: CLOCK, useValue: clock },
          { provide: PUBLIC_WEB_ORIGIN, useValue: origin },
        ],
      }).compile();
      // Handlers register with the buses when the module initialises.
      await moduleRef.init();
      try {
        return await moduleRef.get(QueryBus).execute(query);
      } finally {
        await moduleRef.close();
      }
    },
  };
}
