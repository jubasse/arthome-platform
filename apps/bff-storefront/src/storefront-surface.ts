import { RefusalException, schemaInvalidRefusal } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';

import { Surface } from '@arthome/core';

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

export function assertStorefrontSurface(header: string | undefined): void {
  if (!StorefrontSurfaceSchema.safeParse(header).success) {
    throw new RefusalException(
      HttpStatus.BAD_REQUEST,
      schemaInvalidRefusal([{ path: [SURFACE_HEADER] }]),
    );
  }
}

/** The contract's `VaryAuth`: public and identified bodies, and each surface's slice, kept apart. */
export const VARY_AUTH = 'Cookie, Authorization, X-Arthome-Device-Token, X-Arthome-Surface';
