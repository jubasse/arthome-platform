import { edgeProviders } from '@arthome-platform/http-edge';
import type { Provider } from '@nestjs/common';

import { Service } from '@arthome/core';

import { CLOCK } from './clock.js';
import { UNIQUE_VIOLATION_CODES } from './unique-violations.js';

/** Bound by `AppModule` and by the HTTP suites, so a suite answers what the service answers. */
export const EDGE_PROVIDERS: Provider[] = edgeProviders({
  service: Service.IDENTITY,
  clock: CLOCK,
  uniqueViolations: UNIQUE_VIOLATION_CODES,
});
