import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { Instant } from '@arthome/core';

export const PREVIEW_METER: unique symbol = Symbol('PreviewMeter');

/**
 * The preview budget (PS4). Called last in the opening's and the renewal's transaction, on its
 *   manager: its row is the lock order's third and last.
 */
export interface PreviewMeter {
  secondsLeft(
    manager: EntityManager,
    accountId: string,
    dateId: string,
    now: Instant,
  ): Promise<number>;
  /** How far a preview token may reach; null when the budget covers nothing. */
  cover(
    manager: EntityManager,
    accountId: string,
    dateId: string,
    now: Instant,
  ): Promise<Instant | null>;
}

/** Until PS4: a non-holder gets no preview, so no unmetered preview ever ships. */
@Injectable()
export class NoPreviewMeter implements PreviewMeter {
  public secondsLeft(): Promise<number> {
    return Promise.resolve(0);
  }

  public cover(): Promise<Instant | null> {
    return Promise.resolve(null);
  }
}
