import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CreateVenueHandler } from './create-venue.handler.js';
import { Venue } from './venue.entity.js';
import { VenuesController } from './venues.controller.js';
import { CatalogTransactionsModule } from '../catalog-transactions.js';

@Module({
  imports: [TypeOrmModule.forFeature([Venue]), CatalogTransactionsModule],
  controllers: [VenuesController],
  providers: [CreateVenueHandler],
})
export class VenuesModule {}
