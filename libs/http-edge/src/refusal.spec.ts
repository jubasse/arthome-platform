import { HttpStatus, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  defineErrorModel,
  defineRoute,
  errorResponse,
  routeBuilder,
} from '@arthome/contracts/http';
import { ApiErrorCode, DomainErrorCode, FailureNature, OrderErrorCode } from '@arthome/core';

import { refuse } from './refusal.js';

const model = defineErrorModel<string>({
  standard: {},
  envelopeOf: (code) => z.object({ error: z.object({ code: z.literal(code) }) }),
});

const placeOrder = routeBuilder(model)
  .version(1)
  .defineRoute({
    method: 'post',
    path: '/orders',
    operationId: 'placeOrder',
    errors: { 409: [OrderErrorCode.PRICE_STALE, DomainErrorCode.STATE_CONFLICT] },
    responses: { 201: { description: 'Placed.' } },
  });

/** The list form, on the group and on the route: core's route type carries both lists by status. */
const cancelOrder = routeBuilder(model)
  .version(1)
  .errors([OrderErrorCode.SOLD_OUT])
  .defineRoute({
    method: 'post',
    path: '/orders/{orderId}/cancel',
    operationId: 'cancelOrder',
    parameters: [{ name: 'orderId', in: 'path', required: true, schema: z.string() }],
    errors: [OrderErrorCode.SEAT_CANCEL_DEADLINE_PASSED],
    responses: { 200: { description: 'Cancelled.' } },
  });

const readOrder = defineRoute({
  method: 'get',
  version: 1,
  path: '/orders/{orderId}',
  operationId: 'readOrder',
  parameters: [{ name: 'orderId', in: 'path', required: true, schema: z.string() }],
  responses: {
    200: { description: 'The order.' },
    404: errorResponse(z.object({}), {
      description: 'No such order.',
      code: ApiErrorCode.NOT_FOUND,
    }),
  },
});

/** A route whose typed `errorCodes` is out of step with the list it holds at run time. */
const drifted: Omit<typeof placeOrder, 'errorCodes'> & {
  readonly errorCodes: { readonly 409: readonly [typeof OrderErrorCode.SOLD_OUT] };
} = { ...placeOrder, errorCodes: { 409: [] as never } };

const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

afterEach(() => {
  logged.mockClear();
});

describe('refuse(route, code, params)', () => {
  it('answers a declared code at its registry status, with its params and nature', () => {
    const refusal = refuse(placeOrder, OrderErrorCode.PRICE_STALE, {
      expectedAmountMinor: 4500,
      currentAmountMinor: 5200,
      currencyCode: 'EUR',
    });

    expect(refusal.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(refusal.refusal).toStrictEqual({
      code: OrderErrorCode.PRICE_STALE,
      params: { expectedAmountMinor: 4500, currentAmountMinor: 5200, currencyCode: 'EUR' },
      nature: FailureNature.REFUSED,
    });
    expect(logged).not.toHaveBeenCalled();
  });

  it('takes a code the route or its group declares in the list form', () => {
    const refusals = [
      refuse(cancelOrder, OrderErrorCode.SEAT_CANCEL_DEADLINE_PASSED),
      refuse(cancelOrder, OrderErrorCode.SOLD_OUT),
      // @ts-expect-error -- cancelOrder declares no order.price_stale.
      refuse(cancelOrder, OrderErrorCode.PRICE_STALE, {
        expectedAmountMinor: 4500,
        currentAmountMinor: 5200,
        currencyCode: 'EUR',
      }),
    ];

    expect(refusals.map((refusal) => refusal.refusal.code)).toStrictEqual([
      OrderErrorCode.SEAT_CANCEL_DEADLINE_PASSED,
      OrderErrorCode.SOLD_OUT,
      OrderErrorCode.PRICE_STALE,
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      'POST /v1/orders/{orderId}/cancel refused with order.price_stale, which it does not declare at 409; answered it anyway.',
    );
  });

  it('takes the code a shared response stands for, without params when the code has none', () => {
    const refusal = refuse(readOrder, ApiErrorCode.NOT_FOUND);

    expect(refusal.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(refusal.refusal.params).toStrictEqual({});
  });

  it('compiles only a code the route declares, with the params the registry gives it', () => {
    const refusals = [
      // @ts-expect-error -- placeOrder does not declare order.sold_out.
      refuse(placeOrder, OrderErrorCode.SOLD_OUT),
      // @ts-expect-error -- state.conflict names the version the caller must read again.
      refuse(placeOrder, DomainErrorCode.STATE_CONFLICT),
      // @ts-expect-error -- readOrder declares no 409.
      refuse(readOrder, DomainErrorCode.STATE_CONFLICT, { currentVersion: 3 }),
    ];

    expect(refusals.map((refusal) => refusal.getStatus())).toStrictEqual([
      HttpStatus.CONFLICT,
      HttpStatus.CONFLICT,
      HttpStatus.CONFLICT,
    ]);
  });

  it('answers a code its runtime declaration leaves out, and logs the route and the code', () => {
    const refusal = refuse(drifted, OrderErrorCode.SOLD_OUT);

    expect(refusal.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(refusal.refusal.code).toBe(OrderErrorCode.SOLD_OUT);
    expect(logged).toHaveBeenCalledWith(
      'POST /v1/orders refused with order.sold_out, which it does not declare at 409; answered it anyway.',
    );
  });
});
