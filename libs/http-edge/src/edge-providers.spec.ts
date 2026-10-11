import { httpApp } from '@arthome-platform/testing';
import { Controller, Injectable, Module, type ExecutionContext } from '@nestjs/common';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  DiscoveryService,
  HttpAdapterHost,
  MetadataScanner,
  Reflector,
} from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  defineErrorModel,
  identity,
  routeBuilder,
  type HandlerInput,
  type HandlerOutput,
} from '@arthome/contracts/http';
import { Service, SystemClock } from '@arthome/core';

import { CallerServiceRule } from './caller-service.rule.js';
import { edgeProviders } from './edge-providers.js';
import { ENDPOINT_GUARDS, EndpointGuardsCheck, type IdentityGuard } from './endpoint-access.js';
import { EndpointInput } from './endpoint-input.js';
import { Endpoint, serveEndpoints } from './endpoint.js';
import { ServiceIdentity } from './internal-token.guard.js';
import { InternalTokenVerifier } from './internal-token.verifier.js';
import { JsonBodiesOnly } from './json-bodies-only.js';

const CLOCK = Symbol('Clock');

interface BoundProvider {
  readonly provide: unknown;
  readonly inject?: readonly unknown[];
  readonly useValue?: unknown;
}

const bound = edgeProviders({ service: Service.CATALOG, clock: CLOCK }).map((provider) =>
  typeof provider === 'function' ? { provide: provider } : provider,
) as BoundProvider[];
const providerOf = (token: unknown): BoundProvider | undefined =>
  bound.filter(({ provide }) => provide === token).at(-1);

describe('edgeProviders', () => {
  it('binds each global enhancer once, and the system clock under the service’s token', () => {
    expect(bound.map(({ provide }) => provide)).toEqual([
      ENDPOINT_GUARDS,
      APP_GUARD,
      APP_INTERCEPTOR,
      DiscoveryService,
      MetadataScanner,
      EndpointGuardsCheck,
      ServiceIdentity,
      CallerServiceRule,
      APP_PIPE,
      APP_FILTER,
      APP_INTERCEPTOR,
      InternalTokenVerifier,
      APP_GUARD,
      APP_GUARD,
      CLOCK,
      JsonBodiesOnly,
    ]);
    expect(providerOf(CLOCK)?.useValue).toBeInstanceOf(SystemClock);
  });

  it('hands both envelopes the clock the service’s modules inject, which a suite overrides', () => {
    expect(providerOf(APP_FILTER)?.inject).toEqual([HttpAdapterHost, CLOCK]);
    expect(providerOf(APP_INTERCEPTOR)?.inject).toEqual([CLOCK]);
  });

  it('verifies the internal token before refusing what no slice authorises yet', () => {
    const guards = bound.filter(({ provide }) => provide === APP_GUARD).slice(1);
    expect(guards.map(({ inject }) => inject)).toEqual([
      [InternalTokenVerifier, Reflector],
      [Reflector],
    ]);
    expect(providerOf(InternalTokenVerifier)?.inject).toEqual([CLOCK]);
  });
});

const MACHINE_HEADER = 'x-test-machine';

const machine = identity('machine', {
  schemes: { read: [{ machineSecret: [] }], write: [{ machineSecret: [] }] },
  principal: z.object({ name: z.string() }),
  internal: true,
});

const pingAsMachine = routeBuilder(
  defineErrorModel<string>({
    standard: {},
    envelopeOf: (code) => z.object({ error: z.object({ code: z.literal(code) }) }),
  }),
)
  .version(1)
  .identity(machine)
  .defineRoute({
    method: 'get',
    path: '/machine/ping',
    operationId: 'pingAsMachine',
    responses: {
      200: {
        description: 'Who called.',
        content: {
          'application/json': {
            schema: z.looseObject({ servedAt: z.string(), data: z.object({ by: z.string() }) }),
          },
        },
      },
    },
  });

@Controller()
class MachineController {
  @Endpoint(pingAsMachine)
  public async pingAsMachine(
    @EndpointInput(pingAsMachine) { principal }: HandlerInput<typeof pingAsMachine>,
  ): Promise<HandlerOutput<typeof pingAsMachine>> {
    return Promise.resolve({ data: { by: principal.name } });
  }
}

@Module({ controllers: [MachineController] })
class MachineModule {}

@Injectable()
class MachineIdentity implements IdentityGuard {
  public identify(context: ExecutionContext): Promise<unknown> {
    const name = context.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers[
      MACHINE_HEADER
    ];
    return Promise.resolve(name === undefined ? null : { name });
  }
}

describe('edgeProviders, with another identity', () => {
  it('binds its guard for the routes that declare it', async () => {
    const app = await httpApp({
      imports: [MachineModule],
      providers: edgeProviders({
        service: Service.CATALOG,
        clock: CLOCK,
        identities: { machine: MachineIdentity },
      }),
      configure: serveEndpoints,
    });
    try {
      const anonymous = await app.inject({ method: 'GET', url: '/v1/machine/ping' });
      const identified = await app.inject({
        method: 'GET',
        url: '/v1/machine/ping',
        headers: { [MACHINE_HEADER]: 'origin' },
      });

      expect(anonymous.statusCode).toBe(401);
      expect(identified.statusCode).toBe(200);
      expect(identified.json()).toMatchObject({ data: { by: 'origin' } });
    } finally {
      await app.close();
    }
  });

  it('refuses a guard named after the internal token’s identity', () => {
    expect(() =>
      edgeProviders({
        service: Service.CATALOG,
        clock: CLOCK,
        identities: { service: MachineIdentity },
      }),
    ).toThrow(/"service" identity/);
  });

  it('still fails the boot on a route whose identity no guard is bound for', async () => {
    await expect(
      httpApp({
        imports: [MachineModule],
        providers: edgeProviders({ service: Service.CATALOG, clock: CLOCK }),
        configure: serveEndpoints,
      }),
    ).rejects.toThrow(/pingAsMachine \(identity machine\)/);
  });
});
