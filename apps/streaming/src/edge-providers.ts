import { readMediaServerSecret } from '@arthome-platform/config';
import { edgeProviders } from '@arthome-platform/http-edge';
import type { Provider } from '@nestjs/common';

import { CLOCK } from './clock.js';
import { MEDIA_SERVER_SECRET, MediaServerIdentity } from './media-server/media-server.identity.js';
import { SERVICE } from './service.js';

/**
 * Bound by `AppModule` and by the HTTP suites, so a suite answers what the service answers. A unique
 *   constraint a request can collide on joins `uniqueViolations` here, or it answers 500. The media
 *   server's secret is read here, so a bad one fails the boot.
 */
export const EDGE_PROVIDERS: Provider[] = [
  ...edgeProviders({
    service: SERVICE,
    clock: CLOCK,
    identities: { mediaServer: MediaServerIdentity },
  }),
  { provide: MEDIA_SERVER_SECRET, useFactory: (): string => readMediaServerSecret() },
];
