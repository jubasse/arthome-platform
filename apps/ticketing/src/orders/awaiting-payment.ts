import { OrderState } from '@arthome/core';

/** An order still waiting for its payment: the only states a payment's failure or expiry moves. */
export const ORDER_STATES_AWAITING_PAYMENT: readonly OrderState[] = [
  OrderState.PENDING,
  OrderState.AWAITING_ACTION,
  OrderState.PROCESSING,
];
