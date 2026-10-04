import type { FactoryProvider, Provider, ValueProvider } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, DiscoveryService, MetadataScanner } from '@nestjs/core';

import {
  ENDPOINT_GUARDS,
  EndpointAccessGuard,
  EndpointGuardsCheck,
  type EndpointGuards,
} from './endpoint-access.js';
import { EndpointResponseInterceptor } from './endpoint-response.interceptor.js';

export type EndpointGuardsBinding =
  Omit<FactoryProvider<EndpointGuards>, 'provide'> | Omit<ValueProvider<EndpointGuards>, 'provide'>;

/**
 * What a process serving `Endpoint` routes binds, its guard table first. Listed BEFORE the process's
 *   other global enhancers: the access guard must run before any guard that reads the caller, and
 *   the response interceptor must wrap the success envelope, whose body its paths describe.
 */
export function endpointProviders(guards: EndpointGuardsBinding): Provider[] {
  const table: Provider = { provide: ENDPOINT_GUARDS, ...guards };
  return [
    table,
    { provide: APP_GUARD, useClass: EndpointAccessGuard },
    { provide: APP_INTERCEPTOR, useClass: EndpointResponseInterceptor },
    DiscoveryService,
    MetadataScanner,
    EndpointGuardsCheck,
  ];
}
