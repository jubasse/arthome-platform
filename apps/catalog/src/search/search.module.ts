import { readOpenSearchUrl } from '@arthome-platform/config';
import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';

import { SystemClock } from '@arthome/core';

import { SearchController } from './search.controller.js';
import { OPENSEARCH, SearchService } from './search.service.js';
import { CLOCK } from '../clock.js';

/** The client has no Nest hook of its own: without this its sockets outlive `app.close()`. */
@Injectable()
class SearchIndexShutdown implements OnApplicationShutdown {
  public constructor(@Inject(OPENSEARCH) private readonly client: Client) {}

  public onApplicationShutdown(): Promise<void> {
    return this.client.close();
  }
}

@Module({
  controllers: [SearchController],
  providers: [
    // No retry here: the surface is the one layer that retries (transport.md §5.8), and each
    // request is bounded by its own deadline.
    {
      provide: OPENSEARCH,
      useFactory: (): Client => new Client({ node: readOpenSearchUrl(), maxRetries: 0 }),
    },
    SearchIndexShutdown,
    SearchService,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class SearchModule {}
