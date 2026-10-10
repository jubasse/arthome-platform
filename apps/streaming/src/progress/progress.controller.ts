import {
  Endpoint,
  EndpointInput,
  assertSameCaller,
  profileOfPrincipal,
  remainingBeforeDeadline,
} from '@arthome-platform/http-edge';
import { Controller, Inject } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { HandlerInput, HandlerOutput } from '@arthome/contracts/http';
import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import type { Clock } from '@arthome/core';

import { ResumePoints } from './resume-points.js';
import { CLOCK } from '../clock.js';
import { accountOf, callerOf } from '../service-caller.js';

const { recordPlaybackPosition, getViewerProgressBatch } = streamingServiceApi.routes;

/**
 * The resume points for the storefront BFF (C3). The owner is the token's profile, which every
 *   route here requires and judges against the body's: a point is a profile's, never read or
 *   written for another of the account.
 */
@Controller()
export class ProgressController {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Last writer wins on the server's rank, and a late write after a release is kept. During a live
   *   (or with no run) nothing is recorded and the stored point answers unchanged (D-111).
   */
  @Endpoint(recordPlaybackPosition)
  public async record(
    @EndpointInput(recordPlaybackPosition)
    { params, body, headers, principal }: HandlerInput<typeof recordPlaybackPosition>,
  ): Promise<HandlerOutput<typeof recordPlaybackPosition>> {
    remainingBeforeDeadline(headers['x-arthome-deadline'], this.clock);
    const accountId = accountOf(principal);
    const caller = callerOf(principal);
    const profileId = profileOfPrincipal(caller);
    assertSameCaller(caller, { deviceId: body.deviceId });

    const points = new ResumePoints(this.dataSource.manager);
    const recorded = await points.recordAfterRun({
      ownerId: profileId,
      accountId,
      profileId,
      deviceId: body.deviceId,
      dateId: params.dateId,
      positionSec: body.positionSec,
      completed: body.completed ?? false,
      at: this.clock.now(),
    });
    const point = recorded ?? (await points.stored(profileId, params.dateId));
    return { data: point ?? {} };
  }

  @Endpoint(getViewerProgressBatch)
  public async batch(
    @EndpointInput(getViewerProgressBatch)
    { body, headers, principal }: HandlerInput<typeof getViewerProgressBatch>,
  ): Promise<HandlerOutput<typeof getViewerProgressBatch>> {
    remainingBeforeDeadline(headers['x-arthome-deadline'], this.clock);
    const accountId = accountOf(principal);
    const caller = callerOf(principal);
    const profileId = profileOfPrincipal(caller);
    assertSameCaller(caller, { profileId: body.profileId });

    const points = new ResumePoints(this.dataSource.manager);
    return { data: await points.progressOn(profileId, accountId, body.dateIds) };
  }
}
