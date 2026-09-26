import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';

import { CreateVenueSchema, type CreateVenueBody } from './create-venue.schema.js';
import { VenuesService } from './venues.service.js';

@Controller('venues')
export class VenuesController {
  public constructor(private readonly venues: VenuesService) {}

  @Post()
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  public create(
    @Body({ schema: CreateVenueSchema }) body: CreateVenueBody,
  ): Promise<{ venueId: string }> {
    return this.venues.create(body);
  }
}
