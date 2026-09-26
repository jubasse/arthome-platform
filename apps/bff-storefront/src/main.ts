import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { env } from './env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  // Same limits as the services: no drain window yet, so a rollout still cuts in-flight requests.
  app.enableShutdownHooks();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

await bootstrap();
