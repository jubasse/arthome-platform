import {
  CollectionResponse,
  RefusalException,
  deadlineExceededException,
} from '@arthome-platform/http-edge';
import { DATE_INDEX_ALIAS } from '@arthome-platform/search-index';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Client, errors } from '@opensearch-project/opensearch';

import { ApiErrorCode, FailureNature, type Clock } from '@arthome/core';

import { searchBodyOf } from './search-body.js';
import { offsetOf } from './search-cursor.js';
import { searchPageOf, type SearchPage, type SearchResponseBody } from './search-page.js';
import type { SearchQuery } from './search-query.schema.js';
import { CLOCK } from '../clock.js';

export const OPENSEARCH: unique symbol = Symbol('OpenSearch');

function mapped(error: unknown): unknown {
  // The deadline ran out during the query, or the caller left: either way nobody reads more.
  if (error instanceof errors.TimeoutError || error instanceof errors.RequestAbortedError) {
    return deadlineExceededException();
  }
  if (error instanceof errors.ConnectionError || error instanceof errors.NoLivingConnectionsError) {
    return new RefusalException(
      HttpStatus.SERVICE_UNAVAILABLE,
      { code: ApiErrorCode.SERVICE_UNAVAILABLE, params: {}, nature: FailureNature.UNAVAILABLE },
      { cause: error },
    );
  }
  return error;
}

@Injectable()
export class SearchService {
  public constructor(
    @Inject(OPENSEARCH) private readonly client: Client,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async search(
    query: SearchQuery,
    remainingMs: number,
    callerLeft: AbortSignal,
  ): Promise<CollectionResponse<SearchPage>> {
    const now = this.clock.now();
    const nowMs = this.clock.nowMs();
    const offset = offsetOf(query.cursor, nowMs);

    const request = this.client.search(
      { index: DATE_INDEX_ALIAS, body: searchBodyOf(query, offset, now) },
      { requestTimeout: remainingMs },
    );
    callerLeft.addEventListener('abort', () => request.abort(), { once: true });
    let body: SearchResponseBody;
    try {
      body = (await request).body as unknown as SearchResponseBody;
    } catch (error) {
      throw mapped(error);
    }

    const { page, validUntil } = searchPageOf(body, query, offset, now, nowMs);
    return new CollectionResponse(page, validUntil);
  }
}
