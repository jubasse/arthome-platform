import { httpApp } from '@arthome-platform/testing';
import { Controller, Module } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  defineRoute,
  type Api,
  type RouteBody,
  type RouteHeaders,
  type RouteParams,
  type RouteQuery,
} from '@arthome/contracts/http';
import { ApiErrorCode, FixedClock, Service } from '@arthome/core';

import { contractSchemaConverter } from './dev-docs.js';
import { edgeProviders } from './edge-providers.js';
import {
  Endpoint,
  EndpointBody,
  EndpointHeaders,
  EndpointParams,
  EndpointQuery,
} from './endpoint.js';

const renameDate = defineRoute({
  method: 'post',
  version: 1,
  path: '/dates/{dateId}/title',
  operationId: 'renameDate',
  tags: ['dates'],
  summary: 'Renames a date.',
  security: [{ sessionCookie: [], csrfToken: [] }, { bearerToken: [] }],
  parameters: [
    { name: 'dateId', in: 'path', required: true, schema: z.string() },
    { name: 'X-Arthome-Surface', in: 'header', required: true, schema: z.enum(['web', 'tv']) },
    { name: 'notify', in: 'query', schema: z.boolean() },
  ],
  requestBody: {
    required: true,
    content: { 'application/json': { schema: z.object({ title: z.string().min(1) }) } },
  },
  responses: {
    201: {
      description: 'Renamed.',
      content: {
        'application/json': {
          schema: z.looseObject({
            servedAt: z.string(),
            data: z.looseObject({ dateId: z.string(), title: z.string(), notified: z.boolean() }),
          }),
        },
      },
    },
    404: { description: 'No such date.' },
  },
});

interface Renamed {
  readonly dateId: string;
  readonly title: string;
  readonly notified: boolean;
}

@Controller()
class DatesController {
  @Endpoint(renameDate)
  public rename(
    @EndpointParams(renameDate) params: RouteParams<typeof renameDate>,
    @EndpointQuery(renameDate) query: RouteQuery<typeof renameDate>,
    @EndpointHeaders(renameDate) _headers: RouteHeaders<typeof renameDate>,
    @EndpointBody(renameDate) body: RouteBody<typeof renameDate>,
  ): Promise<Renamed> {
    return Promise.resolve({
      dateId: params.dateId,
      title: body.title,
      notified: query.notify ?? false,
    });
  }
}

@Controller()
class AnswersOutsideItsRoute {
  // @ts-expect-error -- `title` is missing from the answer, so the 201 body cannot be sent.
  @Endpoint(renameDate)
  public rename(): Promise<{ readonly dateId: string }> {
    return Promise.resolve({ dateId: 'd1' });
  }
}

const CLOCK = Symbol('clock');

@Module({
  controllers: [DatesController],
  providers: edgeProviders({ service: Service.CATALOG, clock: CLOCK }),
})
class DatesModule {}

let app: Awaited<ReturnType<typeof httpApp>>;

beforeAll(async () => {
  app = await httpApp({
    imports: [DatesModule],
    providers: [],
    uriVersioning: true,
    caller: { service: Service.CATALOG, clock: new FixedClock(Date.now()) },
  });
});

afterAll(async () => {
  await app.close();
});

function rename(
  query: Record<string, string>,
  body: unknown,
  surface = 'tv',
): ReturnType<typeof app.inject> {
  return app.inject({
    method: 'POST',
    url: '/v1/dates/d1/title',
    query,
    headers: { 'x-arthome-surface': surface },
    payload: body as Record<string, unknown>,
  });
}

describe('a handler bound to its route', () => {
  it('answers on /v1 and nowhere else: the version is Nest’s, so /v1/v1 is not a route', async () => {
    const send = (url: string): ReturnType<typeof app.inject> =>
      app.inject({
        method: 'POST',
        url,
        headers: { 'x-arthome-surface': 'tv' },
        payload: { title: 'Nuit' },
      });

    expect((await send('/v1/dates/d1/title')).statusCode).toBe(201);
    expect((await send('/v1/v1/dates/d1/title')).statusCode).toBe(404);
    expect((await send('/dates/d1/title')).statusCode).toBe(404);
  });

  it('answers on the route’s path and status, with its inputs decoded from the wire', async () => {
    const response = await rename({ notify: 'true' }, { title: 'Nuit' });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: { dateId: 'd1', title: 'Nuit', notified: true },
    });
    expect(AnswersOutsideItsRoute).toBeDefined();
  });

  it('refuses a header outside the contract with the field named, before the handler runs', async () => {
    const response = await rename({}, { title: 'Nuit' }, 'studio');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: ApiErrorCode.SCHEMA_INVALID, params: { fields: ['x-arthome-surface'] } },
    });
  });

  it('refuses a body and an undeclared query parameter the same way', async () => {
    const body = await rename({}, { title: '' });
    const query = await rename({ page: '2' }, { title: 'Nuit' });

    expect(body.json()).toMatchObject({ error: { params: { fields: ['title'] } } });
    expect(query.json()).toMatchObject({ error: { params: { fields: ['page'] } } });
  });

  it('documents the operation from the route: id, tag, a response per status, security, header', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build(), {
      autoTagControllers: false,
      standardSchemaConverter: contractSchemaConverter({ components: {} } as unknown as Api),
    });
    const operation = document.paths['/v1/dates/{dateId}/title']?.post;

    expect(operation).toMatchObject({
      operationId: 'renameDate',
      tags: ['dates'],
      summary: 'Renames a date.',
      security: [{ sessionCookie: [], csrfToken: [] }, { bearerToken: [] }],
    });
    expect(Object.keys(operation?.responses ?? {})).toEqual(['201', '404']);
    expect(JSON.stringify(operation?.responses['201'])).toContain('"title"');
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'X-Arthome-Surface', in: 'header', required: true }),
        expect.objectContaining({ name: 'dateId', in: 'path' }),
        expect.objectContaining({ name: 'notify', in: 'query' }),
      ]),
    );
    expect(operation?.requestBody).toBeDefined();
  });
});
