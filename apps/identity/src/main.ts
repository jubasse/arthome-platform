import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { env } from './env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  // ⚠ Without this, SIGTERM kills the process before any lifecycle hook runs: the pool is
  //   never closed and in-flight requests are cut mid-reply.
  app.enableShutdownHooks();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

await bootstrap();
