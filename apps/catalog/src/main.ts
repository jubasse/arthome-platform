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

  // ⚠ OFF BY DEFAULT: without this, SIGTERM kills the process and no lifecycle hook
  //   runs at all — the TypeORM pool is never closed and in-flight requests are cut
  //   mid-reply.
  //
  // ⚠ NOT SUFFICIENT ON A ROLLOUT, and there is nowhere to fix that yet. A pod that
  //   closes its server the instant SIGTERM arrives refuses new connections while its
  //   endpoint removal is still propagating, which the proxy reports as a 502. That
  //   needs a drain window — Terminus `gracefulShutdownTimeoutMs`, or a `preStop`
  //   sleep — and no deployment manifest exists to hold one.
  app.enableShutdownHooks();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

await bootstrap();
