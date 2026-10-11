import { Endpoint, EndpointInput, refusalOf } from '@arthome-platform/http-edge';
import { Controller, Logger } from '@nestjs/common';

import type { HandlerInput, HandlerOutput } from '@arthome/contracts/http';
import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import { ApiErrorCode } from '@arthome/core';

import { attemptOf } from './media-server-attempt.js';
import { RunIngestAuthorizer } from '../run/ingest-authorizer.js';

const { authorizeMediaServerAccess } = streamingServiceApi.routes;

/**
 * MediaMTX's external HTTP authentication, asked before a feed is accepted
 *   (`adr-stream-entitlement.md` §6). A publish goes to the run's ingest authoriser; anything else
 *   is refused. A refusal's reason is logged, never answered; the body is loose and holds the key,
 *   so only its allow-listed fields are ever logged.
 */
@Controller()
export class MediaServerController {
  private readonly logger = new Logger(MediaServerController.name);

  public constructor(private readonly authorizer: RunIngestAuthorizer) {}

  @Endpoint(authorizeMediaServerAccess)
  public async authorize(
    @EndpointInput(authorizeMediaServerAccess)
    { body }: HandlerInput<typeof authorizeMediaServerAccess>,
  ): Promise<HandlerOutput<typeof authorizeMediaServerAccess>> {
    const decided = attemptOf(body);
    if (decided.kind === 'refusal') {
      this.logger.warn(
        `media server attempt refused (action ${JSON.stringify(body.action)}, protocol ${JSON.stringify(body.protocol)}): ${decided.reason}`,
      );
      throw refusalOf(ApiErrorCode.FORBIDDEN);
    }
    const decision = await this.authorizer.authorize(decided.attempt);
    if (!decision.accepted) throw refusalOf(ApiErrorCode.FORBIDDEN);
  }
}
