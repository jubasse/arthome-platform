import { Endpoint, EndpointInput, serveEndpoints } from '@arthome-platform/http-edge';
import { startStack, type StartedStack } from '@arthome-platform/testing';
import { Controller, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  defineErrorModel,
  routeBuilder,
  throttle,
  type HandlerInput,
} from '@arthome/contracts/http';
import { ApiErrorCode, AuthRateLimit, FailureNature } from '@arthome/core';

import { THROTTLER_REDIS, throttlerRedis } from './throttler-storage.js';
import { AppModule } from '../app.module.js';

/**
 * A `throttle(bucket)` rule counted in Redis against core's cap of that name, on a fixture route
 *   declared through the new builder: no storefront route has opted in yet.
 */

const STARTUP_MS = 240_000;
const CAP = AuthRateLimit.EMAIL_VERIFICATION_RESEND_PER_ACCOUNT;

const resend = routeBuilder(
  defineErrorModel<string>({
    standard: {},
    envelopeOf: (code) => z.object({ error: z.object({ code: z.literal(code) }) }),
  }),
)
  .version(1)
  .public()
  .requires(throttle('EMAIL_VERIFICATION_RESEND_PER_ACCOUNT'))
  .defineRoute({
    method: 'post',
    path: '/fixture/resend',
    operationId: 'fixtureResend',
    responses: {
      200: {
        description: 'Queued.',
        content: {
          'application/json': {
            schema: z.looseObject({
              servedAt: z.string(),
              data: z.object({ queued: z.boolean() }),
            }),
          },
        },
      },
    },
  });

@Controller()
class FixtureController {
  @Endpoint(resend)
  public async resend(
    @EndpointInput(resend) _input: HandlerInput<typeof resend>,
  ): Promise<{ queued: boolean }> {
    return Promise.resolve({ queued: true });
  }
}

@Module({ controllers: [FixtureController] })
class FixtureModule {}

let redis: StartedStack;
let app: NestFastifyApplication;

beforeAll(async () => {
  redis = await startStack({ redis: true, startupTimeoutMs: STARTUP_MS });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, FixtureModule] })
    .overrideProvider(THROTTLER_REDIS)
    .useValue(throttlerRedis(redis.redis.url))
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  serveEndpoints(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await redis?.stop();
});

function resendFrom(address: string) {
  return app.inject({ method: 'POST', url: '/v1/fixture/resend', remoteAddress: address });
}

describe('a throttle rule', () => {
  it('counts the route against its cap, and refuses past it with the contract’s 429', async () => {
    const answers = [];
    for (let attempt = 0; attempt <= CAP.limit; attempt += 1) {
      answers.push(await resendFrom('198.51.100.7'));
    }
    const refused = answers.at(-1);

    expect(answers.slice(0, CAP.limit).map((answer) => answer.statusCode)).toEqual(
      Array.from({ length: CAP.limit }, () => 200),
    );
    expect(refused?.statusCode).toBe(429);
    expect(refused?.json()).toMatchObject({
      error: { code: ApiErrorCode.RATE_LIMITED, nature: FailureNature.UNAVAILABLE },
    });
    expect(Number(refused?.headers['retry-after-ms'])).toBeGreaterThan(0);
  });

  it('counts each caller apart', async () => {
    expect((await resendFrom('198.51.100.8')).statusCode).toBe(200);
  });
});
