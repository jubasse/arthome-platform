import { edgeProviders } from '@arthome-platform/http-edge';
import type { Provider } from '@nestjs/common';

import { CLOCK } from './clock.js';

/**
 * Bound by `AppModule` and by the HTTP suites, so a suite answers what the service answers. No
 *   unique constraint a request can collide on: `date_sales` is keyed by catalog's date id, and
 *   only the consumer inserts it. A new one joins `uniqueViolations` here, or it answers 500.
 */
export const EDGE_PROVIDERS: Provider[] = edgeProviders({ clock: CLOCK });
