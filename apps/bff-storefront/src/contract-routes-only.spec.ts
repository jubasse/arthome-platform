import { Endpoint } from '@arthome-platform/http-edge';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import type { HandlerOutput } from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';

import { AppModule } from './app.module.js';
import { ContractRoutesOnly } from './contract-routes-only.js';

const { signOut } = storefrontApi.routes;

@Controller()
class EscapingController {
  @Get('/escaping')
  public escaping(): string {
    return this.outsideTheContract();
  }

  @Post('/escaping')
  public escapingWrite(): string {
    return this.outsideTheContract();
  }

  private outsideTheContract(): string {
    return `${EscapingController.name} serves outside the contract`;
  }
}

@Module({ controllers: [EscapingController] })
class EscapingModule {}

@Controller()
class BoundController {
  @Endpoint(signOut)
  public signOut(): Promise<HandlerOutput<typeof signOut>> {
    return Promise.resolve({ data: { signedOut: true } });
  }
}

@Module({ controllers: [BoundController] })
class BoundModule {}

describe('the contract-only boot check', () => {
  it('names each route that is not an Endpoint route, not a helper, and refuses to start', async () => {
    await expect(
      Test.createTestingModule({ imports: [AppModule, EscapingModule] })
        .compile()
        .then((module) => module.init()),
    ).rejects.toThrow(
      'Routes outside the contract (not @Endpoint): EscapingController.escaping, EscapingController.escapingWrite.',
    );
  });

  it('lets a controller of Endpoint routes start and the health probe apart', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule, BoundModule] }).compile();
    const check = module.get(ContractRoutesOnly);

    expect(() => check.onModuleInit()).not.toThrow();
    await module.close();
  });
});
