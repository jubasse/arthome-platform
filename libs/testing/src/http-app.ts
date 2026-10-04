import type { ModuleMetadata, Provider } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { mintInternalToken, type InternalCaller } from './internal-token.js';

export interface HttpAppOptions {
  readonly imports: NonNullable<ModuleMetadata['imports']>;
  /** The service's global providers, the very list its root module binds. */
  readonly providers: Provider[];
  /** The suite's migrated one, shared with the app, which destroys it on `close()`. */
  readonly dataSource?: DataSource;
  /** A value per token: the suite's clock, a client it stubs. */
  readonly overrides?: readonly (readonly [token: unknown, value: unknown])[];
  /** As the service's `main.ts` bootstraps it, for a route that verifies a signature. */
  readonly rawBody?: boolean;
  /** What the service's `main.ts` does to the app before `init()`: `serveEndpoints` for `Endpoint` routes. */
  readonly configure?: (app: NestFastifyApplication) => void;
  /**
   * Who the requests come from: each one without an `authorization` header gets this caller's
   *   internal token, minted on the suite's clock. Absent, a request carries only what it sends.
   */
  readonly caller?: InternalCaller;
}

/**
 * Feature modules over HTTP on Fastify, with the service's global providers and the root
 *   `CqrsModule.forRoot()`: what its root module binds, minus the modules a suite leaves out.
 */
export async function httpApp({
  imports,
  providers,
  dataSource,
  overrides = [],
  rawBody = false,
  configure,
  caller,
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
    providers,
  });
  for (const [token, value] of overrides) builder = builder.overrideProvider(token).useValue(value);

  const app = (await builder.compile()).createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false, rawBody },
  );
  configure?.(app);
  if (caller !== undefined) {
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', async (request) => {
        // eslint-disable-next-line no-param-reassign -- the request is the token's carrier, as from a BFF.
        request.headers.authorization ??= `Bearer ${await mintInternalToken(caller)}`;
      });
  }
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
