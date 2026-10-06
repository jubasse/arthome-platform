import 'reflect-metadata';

import { serveEndpoints } from '@arthome-platform/http-edge';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { env } from './env.js';
import { mountStreamingDocs } from './streaming-docs.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  // Without it SIGTERM runs no lifecycle hook: the pool is never closed and in-flight requests are
  //   cut mid-reply. A rollout still needs a drain window, which has nowhere to live yet.
  app.enableShutdownHooks();
  serveEndpoints(app);
  mountStreamingDocs(app);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

await bootstrap();
