import { refusalOf } from '@arthome-platform/http-edge';
import { z } from 'zod';

import { ApiErrorCode, SchemaIssueRule, Surface, type StorefrontSurface } from '@arthome/core';

/**
 * The narrowing `storefront.yaml` declares on `X-Arthome-Surface`: a studio surface here is a
 *   caller in the wrong place, refused rather than tolerated.
 */
const StorefrontSurfaceSchema = z.enum([
  Surface.STOREFRONT_WEB,
  Surface.STOREFRONT_MOBILE,
  Surface.STOREFRONT_TV,
]);

export const SURFACE_HEADER = 'x-arthome-surface';

export function assertStorefrontSurface(header: string | undefined): StorefrontSurface {
  const surface = StorefrontSurfaceSchema.safeParse(header);
  if (!surface.success) {
    throw refusalOf(ApiErrorCode.SCHEMA_INVALID, {
      issues: [
        {
          path: [SURFACE_HEADER],
          rule: SchemaIssueRule.INVALID_VALUE,
          values: [...StorefrontSurfaceSchema.options],
        },
      ],
    });
  }
  return surface.data;
}
