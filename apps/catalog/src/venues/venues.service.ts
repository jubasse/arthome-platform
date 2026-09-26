import { schemaInvalidException } from '@arthome-platform/http-edge';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { CreateVenueBody } from './create-venue.schema.js';
import { isKnownTimeZone } from './venue-clock.js';
import { Venue } from './venue.entity.js';

@Injectable()
export class VenuesService {
  public constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  public async create(body: CreateVenueBody): Promise<{ venueId: string }> {
    if (!isKnownTimeZone(body.timeZone)) throw schemaInvalidException([{ path: ['timeZone'] }]);

    const venueId = uuidv7();
    await this.dataSource.getRepository(Venue).insert({
      id: venueId,
      name: body.name,
      city: body.city,
      country: body.country,
      time_zone: body.timeZone,
    });
    return { venueId };
  }
}
