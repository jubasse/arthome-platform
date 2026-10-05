import { httpApp } from '@arthome-platform/testing';
import { Controller, Logger, Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, HttpAdapterHost } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defineErrorModel,
  restricted,
  routeBuilder,
  sensitive,
  type Api,
  type HandlerInput,
  type HandlerOutput,
} from '@arthome/contracts/http';
import { ApiErrorCode, FixedClock } from '@arthome/core';

import { contractSchemaConverter } from './dev-docs.js';
import { EndpointInput } from './endpoint-input.js';
import { endpointProviders } from './endpoint-providers.js';
import { Endpoint, serveEndpoints } from './endpoint.js';
import { ErrorEnvelopeFilter } from './error-envelope.filter.js';
import { schemaInvalidException } from './refusal.js';
import { MemorisedResponse, SuccessEnvelopeInterceptor } from './success-envelope.interceptor.js';

const NOW = '2026-10-05T10:00:00.000Z';

const model = defineErrorModel<string>({
  standard: {},
  envelopeOf: (code) => z.object({ error: z.object({ code: z.literal(code) }) }),
});

const envelope = <S extends z.ZodType>(data: S) => z.looseObject({ servedAt: z.string(), data });
const json = <S extends z.ZodType>(schema: S) => ({ 'application/json': { schema } });

const exportRows = routeBuilder(model)
  .version(1)
  .public()
  .defineRoute({
    method: 'post',
    path: '/exports',
    operationId: 'exportRows',
    requestBody: {
      required: true,
      content: json(
        z.object({ answer: z.enum(['ready', 'queued', 'undeclared', 'misshapen', 'refused']) }),
      ),
    },
    responses: {
      200: {
        description: 'Ready.',
        content: json(
          envelope(z.object({ url: z.string(), rows: restricted(z.number(), 'audit') })),
        ),
      },
      202: {
        description: 'Queued.',
        content: json(envelope(z.object({ pollToken: sensitive(z.string()), rows: z.number() }))),
      },
      409: { description: 'An export is running.' },
    },
  });

type Output = HandlerOutput<typeof exportRows>;

@Controller()
class ExportsController {
  @Endpoint(exportRows)
  public async exportRows(
    @EndpointInput(exportRows) { body }: HandlerInput<typeof exportRows>,
  ): Promise<Output> {
    switch (body.answer) {
      case 'ready':
        return Promise.resolve({ status: 200, body: { data: { url: '/e1.csv', rows: 3 } } });
      case 'queued':
        return Promise.resolve({ status: 202, body: { data: { pollToken: 'p1', rows: 3 } } });
      case 'undeclared':
        return Promise.resolve({ status: 203, body: { data: {} } } as unknown as Output);
      case 'misshapen':
        return Promise.resolve({
          status: 202,
          body: { data: { url: '/e1.csv' } },
        } as unknown as Output);
      case 'refused':
        return Promise.reject(new Error('the export store is down'));
    }
  }
}

@Controller()
class AnswersWithoutItsStatus {
  // @ts-expect-error -- a route declaring several success statuses is answered `{ status, body }`.
  @Endpoint(exportRows)
  public async exportRows(): Promise<{ readonly data: { readonly url: string } }> {
    return Promise.resolve({ data: { url: '/e1.csv' } });
  }
}

@Controller()
class ReplaysWithoutItsStatus {
  // @ts-expect-error -- a memorised answer carries no status to replay.
  @Endpoint(exportRows)
  public async exportRows(): Promise<MemorisedResponse<{ readonly url: string }>> {
    return Promise.resolve(
      new MemorisedResponse({ servedAt: NOW, data: { url: '/e1.csv' } }, true),
    );
  }
}

@Module({ controllers: [ExportsController] })
class ExportsModule {}

const clock = new FixedClock(NOW);
// The app runs with `logger: false`, which silences the output and not the calls.
const logged = vi.spyOn(Logger.prototype, 'error');

let app: Awaited<ReturnType<typeof httpApp>>;

beforeAll(async () => {
  app = await httpApp({
    imports: [ExportsModule],
    providers: [
      ...endpointProviders({ useValue: { identities: {}, rules: {} } }),
      {
        provide: APP_PIPE,
        useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
      },
      {
        provide: APP_FILTER,
        inject: [HttpAdapterHost],
        useFactory: (host: HttpAdapterHost) => new ErrorEnvelopeFilter(host, clock),
      },
      { provide: APP_INTERCEPTOR, useValue: new SuccessEnvelopeInterceptor(clock) },
    ],
    configure: serveEndpoints,
  });
});

afterAll(async () => {
  await app.close();
});

const exportAnswering = (answer: string) =>
  app.inject({ method: 'POST', url: '/v1/exports', payload: { answer } });

describe('a route declaring several success statuses', () => {
  it('answers the status its handler chose, with that status’s body enveloped', async () => {
    const ready = await exportAnswering('ready');
    const queued = await exportAnswering('queued');

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toStrictEqual({ servedAt: NOW, data: { url: '/e1.csv' } });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toStrictEqual({ servedAt: NOW, data: { pollToken: 'p1', rows: 3 } });
  });

  it('applies the marks of the chosen status’s body, not those of its siblings', async () => {
    const ready = await exportAnswering('ready');
    const queued = await exportAnswering('queued');

    expect(ready.json<{ data: object }>().data).not.toHaveProperty('rows');
    expect(ready.headers).not.toHaveProperty('cache-control');
    expect(queued.headers['cache-control']).toBe('no-store');
  });

  it('answers 500 to a status the route does not declare, logging the route and the status', async () => {
    const response = await exportAnswering('undeclared');

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.INTERNAL } });
    expect(logged).toHaveBeenCalledWith(
      'exportRows answered 203, which it does not declare; answered 500.',
    );
  });

  it('keeps the 500 of a body outside its chosen status, though the status was chosen first', async () => {
    const response = await exportAnswering('misshapen');

    expect(response.statusCode).toBe(500);
    expect(logged).toHaveBeenCalledWith(
      'exportRows answered outside its declared body, at data.pollToken invalid_type, ' +
        'data.rows invalid_type; answered 500.',
    );
  });

  it('answers a failure with its own status, as on any route', async () => {
    expect((await exportAnswering('refused')).statusCode).toBe(500);
  });

  it('refuses at compile time a bare body, and a memorised one, which carries no status', () => {
    expect(AnswersWithoutItsStatus).toBeDefined();
    expect(ReplaysWithoutItsStatus).toBeDefined();
  });

  it('documents every declared status', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build(), {
      autoTagControllers: false,
      standardSchemaConverter: contractSchemaConverter({ components: {} } as unknown as Api),
    });

    expect(Object.keys(document.paths['/v1/exports']?.post?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '202', '409']),
    );
  });
});
