import {
  Endpoint,
  EndpointInput,
  refuse,
  remainingBeforeDeadline,
} from '@arthome-platform/http-edge';
import { Controller, HttpStatus, Inject } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import type { HandlerInput, HandlerOutput } from '@arthome/contracts/http';
import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import { ApiErrorCode, RunState, type Clock } from '@arthome/core';

import { RunConsoleReader } from './run-console.reader.js';
import { refusedOn, runDeskCallOf } from './run-desk-call.js';
import { CheckRun, MoveRun, type RunMoveTarget } from './run-desk.commands.js';
import { CLOCK } from '../clock.js';

const { getRunConsole, runTechnicalCheck, rehearseRun, goOnAir, endRun, resetRun } =
  streamingServiceApi.routes;

type Transition = typeof rehearseRun | typeof goOnAir | typeof endRun | typeof resetRun;

/**
 * The run desk's console and moves, for the studio BFF (C3). No route reads a profile or a device:
 *   the principal's user is the actor. Per-role authorisation is auth slice B's.
 */
@Controller()
export class RunDeskController {
  public constructor(
    private readonly commands: CommandBus,
    private readonly consoles: RunConsoleReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Endpoint(getRunConsole)
  public async console(
    @EndpointInput(getRunConsole) { params, headers }: HandlerInput<typeof getRunConsole>,
  ): Promise<HandlerOutput<typeof getRunConsole>> {
    remainingBeforeDeadline(headers['x-arthome-deadline'], this.clock);
    const data = await this.consoles.consoleOf(params.dateId);
    if (data === null) throw refuse(getRunConsole, ApiErrorCode.NOT_FOUND);
    return { data };
  }

  @Endpoint(runTechnicalCheck)
  public async check(
    @EndpointInput(runTechnicalCheck)
    { params, headers, principal }: HandlerInput<typeof runTechnicalCheck>,
  ) {
    const call = runDeskCallOf(
      {
        operationId: runTechnicalCheck.operationId,
        resourceId: params.dateId,
        body: null,
        statusCode: HttpStatus.OK,
        headers,
        userId: principal.userId,
      },
      this.clock,
    );
    try {
      return await this.commands.execute(new CheckRun(params.dateId, call));
    } catch (error) {
      throw refusedOn(runTechnicalCheck, error);
    }
  }

  @Endpoint(rehearseRun)
  public rehearse(@EndpointInput(rehearseRun) input: HandlerInput<typeof rehearseRun>) {
    return this.move(rehearseRun, RunState.REHEARSAL, input);
  }

  @Endpoint(goOnAir)
  public goOnAir(@EndpointInput(goOnAir) input: HandlerInput<typeof goOnAir>) {
    return this.move(goOnAir, RunState.ON_AIR, input);
  }

  @Endpoint(endRun)
  public end(@EndpointInput(endRun) input: HandlerInput<typeof endRun>) {
    return this.move(endRun, RunState.ENDED, input);
  }

  @Endpoint(resetRun)
  public reset(@EndpointInput(resetRun) input: HandlerInput<typeof resetRun>) {
    return this.move(resetRun, RunState.IDLE, input);
  }

  private async move(
    route: Transition,
    to: RunMoveTarget,
    { params, body, headers, principal }: HandlerInput<Transition>,
  ) {
    const call = runDeskCallOf(
      {
        operationId: route.operationId,
        resourceId: params.dateId,
        body,
        statusCode: HttpStatus.OK,
        headers,
        userId: principal.userId,
      },
      this.clock,
    );
    try {
      return await this.commands.execute(
        new MoveRun(params.dateId, to, body.expectedVersion, call),
      );
    } catch (error) {
      throw refusedOn(route, error);
    }
  }
}
