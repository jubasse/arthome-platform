import { edgeProviders } from '@arthome-platform/http-edge';
import type { Provider } from '@nestjs/common';

import { CLOCK } from './clock.js';
import { SERVICE } from './service.js';

/**
 * Bound by `AppModule` and by the HTTP suites, so a suite answers what the service answers. A unique
 *   constraint a request can collide on joins `uniqueViolations` here, or it answers 500.
 */
export const EDGE_PROVIDERS: Provider[] = edgeProviders({ service: SERVICE, clock: CLOCK });
