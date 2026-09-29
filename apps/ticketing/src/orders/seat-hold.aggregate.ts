import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';

import { holdFor, type Instant, type PriceTier } from '@arthome/core';

import { SeatHoldState, type SeatHoldOrigin } from './commerce-vocabulary.js';
import {
  SeatHoldConsumed,
  SeatHoldPlaced,
  SeatHoldReleased,
  type SeatHoldEvent,
} from './seat-hold.events.js';

export interface SeatHoldSnapshot {
  readonly id: string;
  readonly dateId: string;
  readonly accountId: string | null;
  readonly profileId: string | null;
  readonly tier: PriceTier;
  readonly quantity: number;
  readonly origin: SeatHoldOrigin;
  readonly originRef: string;
  /** The intent's own expiry, one instant for both (data-model.md §3.2). */
  readonly expiresAt: Instant;
  readonly state: SeatHoldState;
  readonly version: number;
}

export interface SeatHoldPlacement {
  readonly id: string;
  readonly dateId: string;
  readonly accountId: string | null;
  readonly profileId: string | null;
  readonly tier: PriceTier;
  readonly quantity: number;
  readonly origin: SeatHoldOrigin;
  readonly originRef: string;
  readonly intentExpiresAt: Instant;
}

/**
 * data-model.md §3.2's `SeatHold`: the capacity a purchase carries until it is paid (D-077). Its
 *   seats left `seats_available` in the statement that placed it; consuming, releasing and expiring
 *   it each happen once, from `active`. Expiry is the sweeper's, set-based (adr-ticketing.md §6).
 */
export class SeatHold extends AggregateRoot<SeatHoldEvent> {
  private current: SeatHoldSnapshot;

  private constructor(current: SeatHoldSnapshot) {
    super();
    this.current = frozen(current);
  }

  public static restore(snapshot: SeatHoldSnapshot): SeatHold {
    return new SeatHold(snapshot);
  }

  /** Refuses a quantity core's `holdFor` refuses, `hold.quantity_invalid`. */
  public static place(placement: SeatHoldPlacement, now: Instant): SeatHold {
    const { quantity, expiresAt } = holdFor(placement.quantity, placement.intentExpiresAt);
    const hold = new SeatHold({
      id: placement.id,
      dateId: placement.dateId,
      accountId: placement.accountId,
      profileId: placement.profileId,
      tier: placement.tier,
      quantity,
      origin: placement.origin,
      originRef: placement.originRef,
      expiresAt,
      state: SeatHoldState.ACTIVE,
      version: 1,
    });
    hold.apply(new SeatHoldPlaced(placement.id, placement.dateId, quantity, expiresAt, now));
    return hold;
  }

  public get snapshot(): SeatHoldSnapshot {
    return this.current;
  }

  /**
   * Active, whatever its instant: a hold past its expiry that the sweeper has not reached yet still
   *   carries its seats, and a payment arriving then takes them.
   */
  public get isActive(): boolean {
    return this.current.state === SeatHoldState.ACTIVE;
  }

  public consume(now: Instant): void {
    this.leave(SeatHoldState.CONSUMED);
    const { id, dateId, quantity } = this.current;
    this.apply(new SeatHoldConsumed(id, dateId, quantity, now));
  }

  public release(now: Instant): void {
    this.leave(SeatHoldState.RELEASED);
    const { id, dateId, quantity } = this.current;
    this.apply(new SeatHoldReleased(id, dateId, quantity, now));
  }

  private leave(state: SeatHoldState): void {
    if (!this.isActive) {
      throw new Error(`hold ${this.current.id} is ${this.current.state}, not active`);
    }
    this.current = frozen({ ...this.current, state, version: this.current.version + 1 });
  }
}
