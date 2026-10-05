import { Controller, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApi, defineRoute } from '@arthome/contracts/http';
import { apiDocs } from '@arthome/contracts/openapi';
import { Service } from '@arthome/core';

import { mountDevDocs } from './dev-docs.js';
import { Endpoint, serveEndpoints } from './endpoint.js';

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
  security: [{ sessionCookie: [] }],
  routes: { getOrder },
  components: { schemas: { Order } },
});

const docs = apiDocs({
  info: { title: 'Orders', version: '1.2.0', description: 'What a buyer reads of their orders.' },
  servers: [{ url: 'https://api.example', description: 'production' }],
  tags: [{ name: 'commerce', description: 'Orders and payments.' }],
  securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'session' } },
  modules: [
    {
      getOrder: { description: 'One order, as its buyer sees it.', upstream: [Service.TICKETING] },
    },
  ],
});

@Controller()
class OrdersController {
  @Endpoint(getOrder)
  public order(): Promise<{ readonly data: { readonly id: string; readonly total: number } }> {
    return Promise.resolve({ data: { id: 'o1', total: 1 } });
  }
}

@Module({ controllers: [OrdersController] })
class OrdersModule {}

let app: NestFastifyApplication | undefined;

async function started(
  environment: Record<string, string>,
  title?: string,
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [OrdersModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  serveEndpoints(app);
  mountDevDocs(app, api, {
    docs,
    path: 'docs',
    environment,
    ...(title !== undefined && { title }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

afterEach(async () => {
  await app?.close();
});

describe('the development documentation', () => {
  it('serves the page and a document of the bound routes, under the docs’ introduction, servers and schemes', async () => {
    const running = await started({ NODE_ENV: 'development' });

    const page = await running.inject({ method: 'GET', url: '/docs' });
    const raw = await running.inject({ method: 'GET', url: '/docs-json' });
    const document = raw.json<{
      info: object;
      servers: unknown[];
      tags: unknown[];
      paths: Record<string, Record<string, object>>;
      components: { securitySchemes: object; schemas: Record<string, unknown> };
    }>();

    expect(page.statusCode).toBe(200);
    expect(document.info).toMatchObject({
      title: 'Orders',
      version: '1.2.0',
      description: 'What a buyer reads of their orders.',
    });
    expect(document.servers).toEqual([{ url: 'https://api.example', description: 'production' }]);
    expect(document.tags).toEqual([{ name: 'commerce', description: 'Orders and payments.' }]);
    expect(document.components.securitySchemes).toHaveProperty('sessionCookie');
    expect(document.components.schemas).toHaveProperty('Order');
  });

  it('documents each bound operation with the prose and meta its module registers', async () => {
    const running = await started({ NODE_ENV: 'development' });

    const document = (await running.inject({ method: 'GET', url: '/docs-json' })).json<{
      paths: Record<string, Record<string, object>>;
    }>();

    expect(document.paths['/v1/orders/{orderId}']?.get).toMatchObject({
      operationId: 'getOrder',
      description: 'One order, as its buyer sees it.',
      'x-arthome-maturity': 'stable',
      'x-arthome-upstream': [Service.TICKETING],
      security: [{ sessionCookie: [] }],
    });
  });

  it('titles the page with a service’s own name when it serves a part of the api', async () => {
    const running = await started({ NODE_ENV: 'development' }, 'Orders service');

    const document = (await running.inject({ method: 'GET', url: '/docs-json' })).json<{
      info: { title: string };
    }>();
    expect(document.info.title).toBe('Orders service');
  });

  it('mounts nothing in production, page and raw document alike', async () => {
    const running = await started({ NODE_ENV: 'production' });

    const page = await running.inject({ method: 'GET', url: '/docs' });
    const raw = await running.inject({ method: 'GET', url: '/docs-json' });

    expect([page.statusCode, raw.statusCode]).toEqual([404, 404]);
  });
});
