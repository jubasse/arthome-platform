import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';

import { Service } from '@arthome/core';

import { InternalTokenMinter } from '../internal-token.minter.js';
import { ServiceClient, type ServiceCall } from '../upstream/service-client.js';

export const CATALOG_URL: unique symbol = Symbol('CatalogUrl');

/**
 * One call to catalog's public reads. Always for an anonymous visitor: the body is the same for
 *   every caller (storefront.yaml), and the viewer's overlays come with the slice that serves them.
 */
export type CatalogCall = Omit<ServiceCall, 'caller'>;

/** The adapter to catalog: its public reads through `ServiceClient`, the token naming no account. */
@Injectable()
export class CatalogClient {
  private readonly client: ServiceClient;

  public constructor(@Inject(CATALOG_URL) baseUrl: string, minter: InternalTokenMinter) {
    this.client = new ServiceClient(Service.CATALOG, baseUrl, minter);
  }

  /** The body, validated against `schema`; any other outcome is one of this BFF's refusals. */
  public async get<T extends z.ZodType>(
    path: string,
    params: URLSearchParams,
    call: CatalogCall,
    schema: T,
  ): Promise<z.output<T>> {
    const answer = await this.client.request(
      { method: 'GET', path, query: params },
      { ...call, caller: null },
      schema,
    );
    return answer.body;
  }
}
