import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { LocalizedCopy } from './artist.entity.js';
import type { UpdateIdentityBody } from './update-identity.schema.js';

export interface ChannelIdentity {
  readonly artistId: string;
  readonly publicName: string;
  readonly slug: string;
  readonly categoryId: string;
  readonly biography: readonly LocalizedCopy[];
}

/**
 * The studio's `updateChannelIdentity`. `expectedVersion: 0` creates the face, and only on a
 *   channel that has none; every later edit names the version it read.
 */
export class UpdateChannelIdentity extends Command<MemorisedResponse<ChannelIdentity>> {
  public constructor(
    public readonly channelId: string,
    public readonly body: UpdateIdentityBody,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
