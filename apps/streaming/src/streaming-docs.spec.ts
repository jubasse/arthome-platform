import { serveEndpoints } from '@arthome-platform/http-edge';
import { Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { streamingServiceDocs } from '@arthome/contracts/streaming-service-api/docs';

import { mountStreamingDocs } from './streaming-docs.js';

@Module({})
class NoRouteModule {}

async function docsIn(environment: Record<string, string>): Promise<{
  readonly status: number;
  readonly title: unknown;
}> {
  const moduleRef = await Test.createTestingModule({ imports: [NoRouteModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  serveEndpoints(app);
  mountStreamingDocs(app, environment);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/docs-json' });
    const title =
      response.statusCode === 200 ? response.json<{ info: { title: unknown } }>().info.title : null;
    return { status: response.statusCode, title };
  } finally {
    await app.close();
  }
}

describe('the streaming service’s development documentation', () => {
  it('opens on the service contract’s introduction in development', async () => {
    expect(await docsIn({ NODE_ENV: 'development' })).toEqual({
      status: 200,
      title: streamingServiceDocs.info?.title,
    });
  });

  it('is not mounted in production, its raw document included', async () => {
    expect((await docsIn({ NODE_ENV: 'production' })).status).toBe(404);
  });
});
