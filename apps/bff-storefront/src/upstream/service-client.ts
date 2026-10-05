import {
  DEADLINE_HEADER,
  RefusalException,
  isPublishedCode,
  type Refusal,
} from '@arthome-platform/http-edge';
import { HttpStatus, Logger } from '@nestjs/common';
import type { z } from 'zod';

import {
  STOREFRONT_RELAYED_CODES,
  StorefrontErrorEnvelopeSchema,
} from '@arthome/contracts/envelope';
import { DERIVED_ERROR_CODES, errorCodesOf, statusOf, type Route } from '@arthome/contracts/http';
import {
  ApiErrorCode,
  FAILURE_NATURES,
  FailureNature,
  memberOr,
  type ErrorCode,
} from '@arthome/core';

import type { Caller, InternalTokenMinter } from '../internal-token.minter.js';

/** What one call to a service carries: who for, the instant it stops being waited for, its trace. */
export interface ServiceCall {
  readonly deadline: Date;
  readonly traceparent: string;
  /** Aborted when the surface hangs up: nobody is waiting for the answer any more. */
  readonly callerLeft: AbortSignal;
  /** Null for an anonymous visitor: the token then names no account. */
  readonly caller: Caller | null;
  /** The BFF route the call serves: the service refusals relayed are the codes it declares. */
  readonly route?: Route;
}

export interface ServiceRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: URLSearchParams;
  readonly body?: unknown;
  /** Relayed as they are: `idempotency-key`. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ServiceAnswer<T> {
  readonly body: T;
  /** The service answered a replayed `Idempotency-Key` with its first answer. */
  readonly replayed: boolean;
}

/**
 * What a service answers about the call itself, its token, its limits, its health: the BFF's
 *   failure, never the viewer's, even where the BFF route declares the same code for its own use.
 */
const HOP_CODES: ReadonlySet<string> = new Set(
  Object.entries(DERIVED_ERROR_CODES)
    .filter(([status]) => Number(status) !== Number(HttpStatus.BAD_REQUEST))
    .flatMap(([, codes]) => codes),
);

/**
 * The status a service's refusal reaches the surface with, or null when it does not. A route that
 *   declares its errors relays its declared codes at their registry status; a route that does not,
 *   or a call made for no route, relays `STOREFRONT_RELAYED_CODES` at the service's status.
 */
function relayedStatusOf(code: string, status: number, route: Route | undefined): number | null {
  if (route?.errorCodes === undefined) {
    return STOREFRONT_RELAYED_CODES.some((relayed) => relayed === code) ? status : null;
  }
  if (!isPublishedCode(code) || HOP_CODES.has(code)) return null;
  const declaredStatus = statusOf(code);
  if (declaredStatus >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) return null;
  return errorCodesOf(route, declaredStatus)?.includes(code) === true ? declaredStatus : null;
}

function isOwnTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

/**
 * The one way this BFF calls a service (transport.md §5.8): a fresh internal token, the trace and the
 *   deadline it gives up at, the answer validated against the contract's schema, and the service's
 *   refusal relayed only when the call's route declares it. It retries nothing: the surface is the
 *   one layer that does, and it knows whether anyone is still waiting.
 */
export class ServiceClient {
  private readonly logger: Logger;

  public constructor(
    private readonly service: string,
    private readonly baseUrl: string,
    private readonly minter: InternalTokenMinter,
  ) {
    this.logger = new Logger(`${service} client`);
  }

  public async request<T extends z.ZodType>(
    request: ServiceRequest,
    call: ServiceCall,
    schema: T,
  ): Promise<ServiceAnswer<z.output<T>>> {
    const query = request.query?.toString() ?? '';
    const url = `${this.baseUrl}${request.path}${query === '' ? '' : `?${query}`}`;
    // Giving up locally and remotely are the same instant (transport.md §5.3).
    /* eslint-disable-next-line arthome-platform/no-wall-clock -- the machine's time against the
       injected clock's deadline, on purpose since #48 (1308fed): the e2e suites pin that clock an hour
       ahead so this abort never fires under verify's load, and in production both are the system
       clock. Through CLOCK, the flake comes back. */
    const timeout = AbortSignal.timeout(Math.max(0, call.deadline.getTime() - Date.now()));
    let status: number;
    let body: unknown;
    let replayed: boolean;
    try {
      const response = await fetch(url, {
        method: request.method,
        // The relayed headers first, so none of them can replace the token or the deadline.
        headers: {
          ...request.headers,
          authorization: `Bearer ${await this.minter.mint(this.service, call.caller)}`,
          traceparent: call.traceparent,
          [DEADLINE_HEADER]: call.deadline.toISOString(),
          ...(request.body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
        signal: AbortSignal.any([timeout, call.callerLeft]),
      });
      status = response.status;
      replayed = response.headers.get('idempotency-replayed') === 'true';
      body = await response.json();
    } catch (error) {
      // The surface hanging up lands here too, and then nobody reads the answer.
      if (isOwnTimeout(error) || call.callerLeft.aborted) throw this.upstreamTimeout();
      this.logger.warn(`unreachable for ${request.path} (${call.traceparent})`, error);
      throw this.upstreamUnavailable();
    }

    if (status >= 200 && status < 300) {
      const served = schema.safeParse(body);
      if (served.success) return { body: served.data, replayed };
      this.logger.warn(
        `answered ${request.path} outside the contract (${call.traceparent})`,
        served.error.issues,
      );
      throw this.upstreamUnavailable();
    }
    throw this.refusalFor(status, body, request.path, call);
  }

  private refusalFor(
    status: number,
    body: unknown,
    path: string,
    call: ServiceCall,
  ): RefusalException {
    const envelope = StorefrontErrorEnvelopeSchema.safeParse(body);
    const code = envelope.success ? envelope.data.error.code : null;
    if (code === ApiErrorCode.DEADLINE_EXCEEDED) return this.upstreamTimeout();
    const relayedStatus = code === null ? null : relayedStatusOf(code, status, call.route);
    if (envelope.success && relayedStatus !== null) {
      const { error } = envelope.data;
      const refusal: Refusal = {
        code: error.code,
        params: error.params,
        // The contract's declared fallback for a nature this build does not know.
        nature: memberOr(FAILURE_NATURES, error.nature, FailureNature.UNAVAILABLE),
      };
      return new RefusalException(relayedStatus, refusal);
    }
    const servedRoute = call.route === undefined ? '' : ` for ${call.route.operationId}`;
    this.logger.warn(
      `refused ${path}${servedRoute} with ${status} ${code ?? 'no code'} (${call.traceparent})`,
    );
    return this.upstreamUnavailable();
  }

  private upstream(status: HttpStatus, code: ErrorCode): RefusalException {
    return new RefusalException(status, {
      code,
      params: { service: this.service },
      nature: FailureNature.UNAVAILABLE,
    });
  }

  private upstreamTimeout(): RefusalException {
    return this.upstream(HttpStatus.GATEWAY_TIMEOUT, ApiErrorCode.UPSTREAM_TIMEOUT);
  }

  private upstreamUnavailable(): RefusalException {
    return this.upstream(HttpStatus.BAD_GATEWAY, ApiErrorCode.UPSTREAM_UNAVAILABLE);
  }
}
