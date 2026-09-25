import 'reflect-metadata';

import { readEnv } from '@arthome-platform/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // ⚠ READ ONCE, HERE, AND THROW. A configuration fault is a deployment that
  //   should not have started, not a runtime condition to degrade around.
  const env = readEnv();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

await bootstrap();
