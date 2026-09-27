import type { IEvent } from '@nestjs/cqrs';

import type { Instant, PublicationState } from '@arthome/core';

import type { PerformanceDateEvent } from './performance-date.events.js';

export class PublicationStateChanged implements IEvent {
  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly from: PublicationState,
    public readonly to: PublicationState,
    /** The version the change produced. */
    public readonly version: number,
    /** A one-way transition: the way back is refused from now on. */
    public readonly irreversible: boolean,
    public readonly occurredAt: Instant,
  ) {}
}

/** Publishing commits the displayed prices, the replay and the chat mode. */
export class PublicationEngaged implements IEvent {
  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly occurredAt: Instant,
  ) {}
}

export type PublicationEvent = PublicationStateChanged | PublicationEngaged;

/** Every domain event keyed by a date: its own and its publication's. */
export type DateOrPublicationEvent = PerformanceDateEvent | PublicationEvent;
