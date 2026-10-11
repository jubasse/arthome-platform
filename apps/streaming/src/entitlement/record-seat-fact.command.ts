import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { Delivery } from '../delivery.js';

/** A seat's activation or its cancellation, whatever its reason (D-095: a refund alone stops nothing). */
export interface SeatFact {
  readonly type: 'ticketing.seat.activated.v1' | 'ticketing.seat.cancelled.v1';
  readonly seatId: string;
  readonly accountId: string;
  readonly dateId: string;
  readonly statedAt: Date;
}

/** Only the seat is needed to end it: what the message leaves out, the kept row already holds. */
export interface SeatCancellationOfKeptRow {
  readonly type: 'ticketing.seat.cancelled.v1';
  readonly seatId: string;
  readonly statedAt: Date | null;
}

export type SeatMessageFact = SeatFact | SeatCancellationOfKeptRow;

export const isCancellationOfKeptRow = (fact: SeatMessageFact): fact is SeatCancellationOfKeptRow =>
  !('accountId' in fact);

export class RecordSeatFact extends Command<Outcome> {
  public constructor(
    public readonly delivery: Delivery,
    public readonly fact: SeatMessageFact,
  ) {
    super();
  }
}
