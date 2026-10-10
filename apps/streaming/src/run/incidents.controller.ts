import { Endpoint, EndpointInput } from '@arthome-platform/http-edge';
import { Controller, HttpStatus, Inject } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import type { HandlerInput } from '@arthome/contracts/http';
import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import type { Clock } from '@arthome/core';

import { refusedOn, runDeskCallOf } from './run-desk-call.js';
import { RaiseIncident, ResolveIncident } from './run-desk.commands.js';
import { CLOCK } from '../clock.js';

const { raiseIncident, resolveIncident } = streamingServiceApi.routes;

/** The veil raised and lifted by hand, for the studio BFF (C3); the principal's user is the actor. */
@Controller()
export class IncidentsController {
  public constructor(
    private readonly commands: CommandBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** One open incident per run: a second, or one on an ended run, is refused `state.conflict`. */
  @Endpoint(raiseIncident)
  public async raise(
    @EndpointInput(raiseIncident)
    { params, body, headers, principal }: HandlerInput<typeof raiseIncident>,
  ) {
    const call = runDeskCallOf(
      {
        operationId: raiseIncident.operationId,
        resourceId: params.dateId,
        body,
        statusCode: HttpStatus.CREATED,
        headers,
        userId: principal.userId,
      },
      this.clock,
    );
    const { incidentId, kind, cause, message } = body;
    try {
      return await this.commands.execute(
        new RaiseIncident(params.dateId, { id: incidentId, kind, cause, message }, call),
      );
    } catch (error) {
      throw refusedOn(raiseIncident, error);
    }
  }

  @Endpoint(resolveIncident)
  public async resolve(
    @EndpointInput(resolveIncident)
    { params, headers, principal }: HandlerInput<typeof resolveIncident>,
  ) {
    const call = runDeskCallOf(
      {
        operationId: resolveIncident.operationId,
        resourceId: params.incidentId,
        body: null,
        statusCode: HttpStatus.OK,
        headers,
        userId: principal.userId,
      },
      this.clock,
    );
    try {
      return await this.commands.execute(new ResolveIncident(params.incidentId, call));
    } catch (error) {
      throw refusedOn(resolveIncident, error);
    }
  }
}
