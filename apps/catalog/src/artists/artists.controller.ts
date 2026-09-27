import { parseTraceparent, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Body, Controller, Header, Headers, HttpCode, Param, Patch } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { UpdateChannelIdentity, type ChannelIdentity } from './update-channel-identity.command.js';
import { UpdateIdentitySchema, type UpdateIdentityBody } from './update-identity.schema.js';
import { ChannelIdParam } from '../channel-id.schema.js';
import { idempotentRequestOf } from '../idempotency/idempotency.js';

@Controller('v1')
export class ArtistsController {
  public constructor(private readonly commands: CommandBus) {}

  @Patch('channels/:channelId/identity')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public updateIdentity(
    @Param('channelId', { schema: ChannelIdParam }) channelId: string,
    @Body({ schema: UpdateIdentitySchema }) body: UpdateIdentityBody,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<ChannelIdentity>> {
    const trace = parseTraceparent(traceparent);
    return this.commands.execute(
      new UpdateChannelIdentity(
        channelId,
        body,
        trace === null ? null : trace.traceparent,
        idempotentRequestOf(
          'PATCH',
          `/v1/channels/${channelId}/identity`,
          body,
          200,
          idempotencyKey,
        ),
      ),
    );
  }
}
