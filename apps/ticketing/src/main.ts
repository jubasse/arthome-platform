import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

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

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

await bootstrap();
