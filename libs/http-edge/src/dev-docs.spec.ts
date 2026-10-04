import { Controller, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApi, defineRoute } from '@arthome/contracts/http';

import { mountDevDocs } from './dev-docs.js';
import { Endpoint, enableUriVersioning } from './endpoint.js';

const Order = z.object({ id: z.string(), total: z.number() });

const getOrder = defineRoute({
  method: 'get',
  version: 1,
  path: '/orders/{orderId}',
  operationId: 'getOrder',
  tags: ['commerce'],
  security: [{ sessionCookie: [] }],
  parameters: [{ name: 'orderId', in: 'path', required: true, schema: z.string() }],
  responses: {
    200: {
      description: 'The order.',
      content: { 'application/json': { schema: z.looseObject({ data: Order }) } },
    },
  },
});

const api = defineApi({
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1.0.0' },
  servers: [{ url: 'https://api.example', description: 'production' }],
  routes: { getOrder },
  components: {
    schemas: { Order },
    securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'session' } },
  },
});

@Controller()
class OrdersController {
  @Endpoint(getOrder)
  public order(): Promise<{ readonly id: string; readonly total: number }> {
    return Promise.resolve({ id: 'o1', total: 1 });
  }
}

@Module({ controllers: [OrdersController] })
class OrdersModule {}

let app: NestFastifyApplication | undefined;

async function started(environment: Record<string, string>): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [OrdersModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  enableUriVersioning(app);
  mountDevDocs(app, api, { title: 'Orders service', path: 'docs', environment });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

afterEach(async () => {
  await app?.close();
});

describe('the development documentation', () => {
  it('serves the page and a document of the bound routes, with the api’s schemes and shared schemas', async () => {
    const running = await started({ NODE_ENV: 'development' });

    const page = await running.inject({ method: 'GET', url: '/docs' });
    const raw = await running.inject({ method: 'GET', url: '/docs-json' });
    const document = raw.json<{
      info: { title: string };
      paths: Record<string, Record<string, { operationId: string; security: unknown }>>;
      components: { securitySchemes: object; schemas: Record<string, unknown> };
    }>();

    expect(page.statusCode).toBe(200);
    expect(document.info.title).toBe('Orders service');
    expect(document.paths['/v1/orders/{orderId}']?.get).toMatchObject({
      operationId: 'getOrder',
      security: [{ sessionCookie: [] }],
    });
    expect(document.components.securitySchemes).toHaveProperty('sessionCookie');
    expect(document.components.schemas).toHaveProperty('Order');
  });

  it('mounts nothing in production, page and raw document alike', async () => {
    const running = await started({ NODE_ENV: 'production' });

    const page = await running.inject({ method: 'GET', url: '/docs' });
    const raw = await running.inject({ method: 'GET', url: '/docs-json' });

    expect([page.statusCode, raw.statusCode]).toEqual([404, 404]);
  });
});
