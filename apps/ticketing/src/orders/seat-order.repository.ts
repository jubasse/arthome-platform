import type { Instant } from '@arthome/core';

import type { SeatOrder } from './seat-order.aggregate.js';

/** The purchase's `Idempotency-Key`, bound to the order it created (adr-ticketing.md §2). */
export interface IdempotencyBinding {
  readonly accountId: string | null;
  readonly key: string;
  readonly fingerprint: string;
}

export interface BoundOrder {
  readonly orderId: string;
  readonly fingerprint: string;
}

export abstract class SeatOrderRepository {
  /** Under the row's lock to the commit, taken before its hold's. */
  public abstract findById(orderId: string): Promise<SeatOrder | null>;

  public abstract findBound(accountId: string | null, key: string): Promise<BoundOrder | null>;

  public abstract nextReference(placedAt: Instant): Promise<string>;

  /**
   * Inserts a new order with its key. False when another purchase bound the key first: the insert
   *   waits for that purchase's transaction, so a duplicate queues on the key, never on the date.
   */
  public abstract place(order: SeatOrder, binding: IdempotencyBinding): Promise<boolean>;

  /** Conditioned on the version it was loaded at; its new seats are inserted with it. */
  public abstract save(order: SeatOrder): Promise<void>;
}
