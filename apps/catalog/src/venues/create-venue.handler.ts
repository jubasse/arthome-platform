import { schemaInvalidException } from '@arthome-platform/http-edge';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import { CreateVenue } from './create-venue.command.js';
import { isKnownTimeZone } from './venue-clock.js';
import { Venue } from './venue.entity.js';
import { CatalogTransactions } from '../catalog-transactions.js';

@CommandHandler(CreateVenue)
export class CreateVenueHandler implements ICommandHandler<CreateVenue> {
  public constructor(private readonly transactions: CatalogTransactions) {}

  public async execute({ venue }: CreateVenue): Promise<{ venueId: string }> {
    if (!isKnownTimeZone(venue.timeZone)) throw schemaInvalidException([{ path: ['timeZone'] }]);

    const venueId = uuidv7();
    await this.transactions.run(({ manager }) =>
      manager.insert(Venue, {
        id: venueId,
        name: venue.name,
        city: venue.city,
        country: venue.country,
        time_zone: venue.timeZone,
      }),
    );
    return { venueId };
  }
}
