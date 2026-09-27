import type { ModuleMetadata } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { CLOCK } from '../clock.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';

export interface HttpAppOptions {
  readonly imports: NonNullable<ModuleMetadata['imports']>;
  readonly clock: Clock;
  /** The suite's migrated one, shared with the app, which destroys it on `close()`. */
  readonly dataSource?: DataSource;
  readonly overrides?: readonly (readonly [token: unknown, value: unknown])[];
}

/**
 * Feature modules over HTTP on Fastify, with the service's own global providers and the root
 *   `CqrsModule.forRoot()`: what `AppModule` binds, minus the modules a suite leaves out.
 */
export async function httpApp({
  imports,
  clock,
  dataSource,
  overrides = [],
}: HttpAppOptions): Promise<NestFastifyApplication> {
  let builder = Test.createTestingModule({
    imports: [
      ...(dataSource === undefined
        ? []
        : [
            TypeOrmModule.forRootAsync({
              useFactory: () => dataSource.options,
              dataSourceFactory: () => Promise.resolve(dataSource),
            }),
          ]),
      CqrsModule.forRoot(),
      ...imports,
    ],
    providers: EDGE_PROVIDERS,
  })
    .overrideProvider(CLOCK)
    .useValue(clock);
  for (const [token, value] of overrides) builder = builder.overrideProvider(token).useValue(value);

  const app = (await builder.compile()).createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
