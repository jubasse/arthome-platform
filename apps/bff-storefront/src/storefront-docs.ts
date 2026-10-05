import { mountDevDocs } from '@arthome-platform/http-edge';
import type { INestApplication } from '@nestjs/common';

import { storefrontApi } from '@arthome/contracts/storefront-api';
import { storefrontDocs } from '@arthome/contracts/storefront-api/docs';

/** The storefront contract's Swagger UI at `/docs`, in development only, from its docs module. */
export function mountStorefrontDocs(
  app: INestApplication,
  environment: Record<string, string | undefined> = process.env,
): void {
  mountDevDocs(app, storefrontApi, { docs: storefrontDocs, path: 'docs', environment });
}
