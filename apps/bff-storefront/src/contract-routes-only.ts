import { EndpointRoute, HealthController } from '@arthome-platform/http-edge';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

const OUTSIDE_THE_CONTRACT = new Set<unknown>([HealthController]);

/** Fails the boot on a controller method that serves a path without being an `@Endpoint` route, so no route escapes the contract. */
@Injectable()
export class ContractRoutesOnly implements OnModuleInit {
  public constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  public onModuleInit(): void {
    const escaping = this.discovery.getControllers().flatMap((wrapper) => {
      const controller = wrapper.metatype as (new () => object) | null;
      if (controller === null || OUTSIDE_THE_CONTRACT.has(controller)) return [];
      const prototype = controller.prototype as Record<string, () => unknown>;
      return this.scanner
        .getAllMethodNames(prototype)
        .filter(
          (name) =>
            Reflect.hasMetadata(METHOD_METADATA, prototype[name] as object) &&
            this.reflector.get(EndpointRoute, prototype[name] as () => unknown) === undefined,
        )
        .map((name) => `${controller.name}.${name}`);
    });
    if (escaping.length > 0) {
      throw new Error(`Routes outside the contract (not @Endpoint): ${escaping.join(', ')}.`);
    }
  }
}
