import type { CollectionResponse } from '@arthome-platform/http-edge';
import { Query } from '@nestjs/cqrs';

import type { SearchPage } from './search-page.js';
import type { SearchQuery } from './search-query.schema.js';

/**
 * The storefront's `search`, `GET /v1/search`. `remainingMs` is what the caller's
 *   `x-arthome-deadline` leaves, and bounds the index request; `callerLeft` aborts it.
 */
export class SearchCatalog extends Query<CollectionResponse<SearchPage>> {
  public constructor(
    public readonly query: SearchQuery,
    public readonly remainingMs: number,
    public readonly callerLeft: AbortSignal,
  ) {
    super();
  }
}
