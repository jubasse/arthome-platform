import { DEADLINE_HEADER, RefusalException, type Refusal } from '@arthome-platform/http-edge';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';

import {
  STOREFRONT_RELAYED_CODES,
  StorefrontErrorEnvelopeSchema,
} from '@arthome/contracts/envelope';
import {
  ApiErrorCode,
  FAILURE_NATURES,
  FailureNature,
  Service,
  memberOr,
  type ErrorCode,
} from '@arthome/core';

export const CATALOG_URL: unique symbol = Symbol('CatalogUrl');

/** What one call to catalog carries: the instant it stops being waited for, and its trace. */
export interface CatalogCall {
  readonly deadline: Date;
  readonly traceparent: string;
  /** Aborted when the surface hangs up: nobody is waiting for the answer any more. */
  readonly callerLeft: AbortSignal;
}

function upstream(status: HttpStatus, code: ErrorCode): RefusalException {
  return new RefusalException(status, {
    code,
    params: { service: Service.CATALOG },
    nature: FailureNature.UNAVAILABLE,
  });
}

const upstreamTimeout = (): RefusalException =>
  upstream(HttpStatus.GATEWAY_TIMEOUT, ApiErrorCode.UPSTREAM_TIMEOUT);
const upstreamUnavailable = (): RefusalException =>
  upstream(HttpStatus.BAD_GATEWAY, ApiErrorCode.UPSTREAM_UNAVAILABLE);

function isOwnTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

/**
 * The one adapter to catalog (transport.md §5.8): bounded by the deadline it sends, typed by
 *   `@arthome/contracts`, and never relaying catalog's error as-is. It retries nothing: the
 *   surface is the one layer that does, and it knows whether anyone is still waiting.
 */
@Injectable()
export class CatalogClient {
  private readonly logger = new Logger(CatalogClient.name);

  public constructor(@Inject(CATALOG_URL) private readonly baseUrl: string) {}

  /** The body, validated against `schema`; any other outcome is one of this BFF's refusals. */
  public async get<T extends z.ZodType>(
    path: string,
    params: URLSearchParams,
    call: CatalogCall,
    schema: T,
  ): Promise<z.output<T>> {
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    // Giving up locally and remotely are the same instant (transport.md §5.3).
    const timeout = AbortSignal.timeout(Math.max(0, call.deadline.getTime() - Date.now()));
    let status: number;
    let body: unknown;
    try {
      const response = await fetch(url, {
        headers: {
          traceparent: call.traceparent,
          [DEADLINE_HEADER]: call.deadline.toISOString(),
        },
        signal: AbortSignal.any([timeout, call.callerLeft]),
      });
      status = response.status;
      body = await response.json();
    } catch (error) {
      // The surface hanging up lands here too, and then nobody reads the answer.
      if (isOwnTimeout(error) || call.callerLeft.aborted) throw upstreamTimeout();
      this.logger.warn(`catalog unreachable for ${path} (${call.traceparent})`, error);
      throw upstreamUnavailable();
    }

    if (status >= 200 && status < 300) {
      const served = schema.safeParse(body);
      if (served.success) return served.data;
      this.logger.warn(
        `catalog answered ${path} outside the contract (${call.traceparent})`,
        served.error.issues,
      );
      throw upstreamUnavailable();
    }
    throw this.refusalFor(status, body, path, call.traceparent);
  }

  private refusalFor(
    status: number,
    body: unknown,
    path: string,
    traceparent: string,
  ): RefusalException {
    const envelope = StorefrontErrorEnvelopeSchema.safeParse(body);
    const code = envelope.success ? envelope.data.error.code : null;
    if (code === ApiErrorCode.DEADLINE_EXCEEDED) return upstreamTimeout();
    if (envelope.success && STOREFRONT_RELAYED_CODES.some((relayed) => relayed === code)) {
      const { error } = envelope.data;
      const refusal: Refusal = {
        code: error.code,
        params: error.params,
        // The contract's declared fallback for a nature this build does not know.
        nature: memberOr(FAILURE_NATURES, error.nature, FailureNature.UNAVAILABLE),
      };
      return new RefusalException(status, refusal);
    }
    this.logger.warn(
      `catalog refused ${path} with ${status} ${code ?? 'no code'} (${traceparent})`,
    );
    return upstreamUnavailable();
  }
}
