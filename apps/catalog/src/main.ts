import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { env } from './env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  // ⚠ Without this, SIGTERM runs no lifecycle hook at all: the TypeORM pool is never closed
  //   and in-flight requests are cut mid-reply.
  // ⚠ Not sufficient on a rollout, and there is nowhere to fix that yet. Closing the server
  //   the instant SIGTERM arrives refuses connections while endpoint removal is still
  //   propagating, which the proxy reports as a 502; that needs a drain window.
  app.enableShutdownHooks();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

await bootstrap();
