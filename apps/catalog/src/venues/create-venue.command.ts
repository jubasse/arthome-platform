import { Command } from '@nestjs/cqrs';

import type { CreateVenueBody } from './create-venue.schema.js';

/** `POST /venues`. */
export class CreateVenue extends Command<{ venueId: string }> {
  public constructor(public readonly venue: CreateVenueBody) {
    super();
  }
}
