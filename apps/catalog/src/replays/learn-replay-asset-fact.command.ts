import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { Instant } from '@arthome/core';

import type { ReplayAsset } from './replay.aggregate.js';

export interface ReplayAssetFact {
  readonly dateId: string;
  /** The file streaming announced, with the closing it computed; null when it expired. */
  readonly ready: (ReplayAsset & { readonly expiresAt: Instant | null }) | null;
}

/** Dispatched by the run consumer for `replay.asset_ready` and `replay.expired`. */
export class LearnReplayAssetFact extends Command<Outcome> {
  public constructor(
    public readonly messageId: string,
    public readonly topic: string,
    public readonly fact: ReplayAssetFact,
    public readonly traceparent: string | null,
  ) {
    super();
  }
}
