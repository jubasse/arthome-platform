import 'reflect-metadata';

import { Body, Controller, Get, HttpCode, HttpException, Param, Post } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApi, defineRoute } from '@arthome/contracts/http';

import { declaredResponses, type DeclaredResponses } from './declared-responses.js';

function envelopeNaming(code: string): z.ZodType {
  return z.object({ error: z.object({ code: z.literal(code) }), servedAt: z.string() });
}

const getThing = defineRoute({
  method: 'get',
  version: 1,
  path: '/things/{thingId}',
  operationId: 'getThing',
  responses: {
    200: { description: 'The thing.' },
    404: {
      description: 'Shared, naming no code.',
      content: {
        'application/json': { schema: z.object({ error: z.object({ code: z.string() }) }) },
      },
    },
  },
});

const createThing = defineRoute({
  method: 'post',
  version: 1,
  path: '/things',
  operationId: 'createThing',
  responses: {
    201: { description: 'Created.' },
    409: {
      description: 'One envelope per code.',
      content: {
        'application/json': {
          schema: z.union([envelopeNaming('thing.taken'), envelopeNaming('thing.locked')]),
        },
      },
    },
  },
});

const api = defineApi({
  openapi: '3.1.0',
  info: { title: 'things' },
  routes: { getThing, createThing },
  components: {},
});

function refusal(status: number, code: string): HttpException {
  return new HttpException({ error: { code }, servedAt: '2026-10-04T10:00:00.000Z' }, status);
}

@Controller()
class ThingsController {
  @Get('v1/things/:thingId')
  public find(@Param('thingId') thingId: string): object {
    if (thingId === 'missing') throw refusal(404, 'api.not_found');
    if (thingId === 'forbidden') throw refusal(403, 'api.forbidden');
    return { id: thingId };
  }

  @Post('v1/things')
  @HttpCode(201)
  public create(@Body() { refusedWith }: { refusedWith: string }): object {
    throw refusal(409, refusedWith);
  }

  @Post('v1/things/archive')
  public archive(): object {
    throw refusal(409, 'thing.archived');
  }

  @Get('health')
  public health(): object {
    return {};
  }
}

let app: NestFastifyApplication;
let responses: DeclaredResponses;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  responses = declaredResponses(api);
  responses.watch(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

async function undeclaredAfter(
  ...requests: Parameters<NestFastifyApplication['inject']>[0][]
): Promise<unknown[]> {
  const from = responses.undeclared.length;
  for (const request of requests) await app.inject(request);
  return responses.undeclared.slice(from);
}

describe('declaredResponses', () => {
  it('passes a declared success, a declared code, and an error whose response names none', async () => {
    const undeclared = await undeclaredAfter(
      { method: 'GET', url: '/v1/things/t1' },
      { method: 'POST', url: '/v1/things', payload: { refusedWith: 'thing.taken' } },
      { method: 'GET', url: '/v1/things/missing' },
    );

    expect(undeclared).toEqual([]);
  });

  it('records a status the route does not declare, with its code', async () => {
    const undeclared = await undeclaredAfter({ method: 'GET', url: '/v1/things/forbidden' });

    expect(undeclared).toEqual([{ operationId: 'getThing', status: 403, code: 'api.forbidden' }]);
  });

  it('records a code the declared response does not name', async () => {
    const undeclared = await undeclaredAfter({
      method: 'POST',
      url: '/v1/things',
      payload: { refusedWith: 'thing.renamed' },
    });

    expect(undeclared).toEqual([
      { operationId: 'createThing', status: 409, code: 'thing.renamed' },
    ]);
  });

  it('records the refusals Fastify makes before the handler', async () => {
    const undeclared = await undeclaredAfter({
      method: 'POST',
      url: '/v1/things',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });

    expect(undeclared).toEqual([{ operationId: 'createThing', status: 400, code: null }]);
  });

  it('leaves alone what no route of the api serves', async () => {
    const undeclared = await undeclaredAfter(
      { method: 'GET', url: '/v1/nowhere' },
      { method: 'GET', url: '/health' },
      { method: 'POST', url: '/v1/things/archive' },
    );

    expect(undeclared).toEqual([]);
  });
});
