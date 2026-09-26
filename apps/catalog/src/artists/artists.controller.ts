import { parseTraceparent, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Body, Controller, Header, Headers, HttpCode, Param, Patch } from '@nestjs/common';

import { ArtistsService, type ChannelIdentity } from './artists.service.js';
import { UpdateIdentitySchema, type UpdateIdentityBody } from './update-identity.schema.js';
import { ChannelIdParam } from '../channel-id.schema.js';
import { fingerprintOf, idempotencyKeyOf } from '../idempotency/idempotency.js';

@Controller('v1')
export class ArtistsController {
  public constructor(private readonly artists: ArtistsService) {}

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
    return this.artists.updateIdentity(
      { channelId, ...body, traceparent: trace === null ? null : trace.traceparent },
      {
        key: idempotencyKeyOf(idempotencyKey),
        accountId: null,
        fingerprint: fingerprintOf('PATCH', `/v1/channels/${channelId}/identity`, body),
        statusCode: 200,
      },
    );
  }
}
