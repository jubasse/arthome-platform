import 'reflect-metadata';

import { serveEndpoints } from '@arthome-platform/http-edge';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { answerNotModified } from './conditional-get.js';
import { authEnv, env } from './env.js';
import { mountStorefrontDocs } from './storefront-docs.js';

async function bootstrap(): Promise<void> {
  // The exact proxies, never `true`: the caps count by address (`nestjs-web-security` rule 7).
  const trustProxy = authEnv.trustedProxies.length > 0 ? [...authEnv.trustedProxies] : false;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy }),
  );
  answerNotModified(app);
  // Same limits as the services: no drain window yet, so a rollout still cuts in-flight requests.
  app.enableShutdownHooks();
  serveEndpoints(app);
  mountStorefrontDocs(app);
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

await bootstrap();
