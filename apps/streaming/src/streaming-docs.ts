import { mountDevDocs } from '@arthome-platform/http-edge';
import type { INestApplication } from '@nestjs/common';

import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import { streamingServiceDocs } from '@arthome/contracts/streaming-service-api/docs';

/** The streaming service contract's Swagger UI at `/docs`, in development only. */
export function mountStreamingDocs(
  app: INestApplication,
  environment: Record<string, string | undefined> = process.env,
): void {
  mountDevDocs(app, streamingServiceApi, { docs: streamingServiceDocs, path: 'docs', environment });
}
