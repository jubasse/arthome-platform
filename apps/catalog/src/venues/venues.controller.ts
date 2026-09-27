import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { CreateVenue } from './create-venue.command.js';
import { CreateVenueSchema, type CreateVenueBody } from './create-venue.schema.js';

@Controller('venues')
export class VenuesController {
  public constructor(private readonly commands: CommandBus) {}

  @Post()
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  public create(
    @Body({ schema: CreateVenueSchema }) body: CreateVenueBody,
  ): Promise<{ venueId: string }> {
    return this.commands.execute(new CreateVenue(body));
  }
}
