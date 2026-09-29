import type { IEvent } from '@nestjs/cqrs';

import type { Instant } from '@arthome/core';

export class SeatHoldPlaced implements IEvent {
  public readonly kind = 'SeatHoldPlaced';

  public constructor(
    public readonly holdId: string,
    public readonly dateId: string,
    public readonly quantity: number,
    public readonly expiresAt: Instant,
    public readonly occurredAt: Instant,
  ) {}
}

/** Its order was paid: the held seats are sold. */
export class SeatHoldConsumed implements IEvent {
  public readonly kind = 'SeatHoldConsumed';

  public constructor(
    public readonly holdId: string,
    public readonly dateId: string,
    public readonly quantity: number,
    public readonly occurredAt: Instant,
  ) {}
}

/** Given back before its expiry: a payment declined, or a provider that did not answer. */
export class SeatHoldReleased implements IEvent {
  public readonly kind = 'SeatHoldReleased';

  public constructor(
    public readonly holdId: string,
    public readonly dateId: string,
    public readonly quantity: number,
    public readonly occurredAt: Instant,
  ) {}
}

export type SeatHoldEvent = SeatHoldPlaced | SeatHoldConsumed | SeatHoldReleased;
