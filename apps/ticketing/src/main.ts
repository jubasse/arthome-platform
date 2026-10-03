import 'reflect-metadata';

import { mountDevDocs } from '@arthome-platform/http-edge';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { storefrontApi } from '@arthome/contracts/storefront-api';

import { AppModule } from './app.module.js';
import { env } from './env.js';

async function bootstrap(): Promise<void> {
  // `rawBody`: a webhook's signature covers its exact bytes (adr-payments.md §7.1).
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    rawBody: true,
  });

  // Without it SIGTERM runs no lifecycle hook: the pool is never closed and in-flight requests are
  //   cut mid-reply. A rollout still needs a drain window, which has nowhere to live yet.
  app.enableShutdownHooks();
  mountDevDocs(app, storefrontApi, {
    title: 'Arthome ticketing, the storefront operations it serves',
    path: 'docs',
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

await bootstrap();
