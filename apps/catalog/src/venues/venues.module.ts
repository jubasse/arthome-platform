import { Module } from '@nestjs/common';

import { CreateVenueHandler } from './create-venue.handler.js';
import { VenuesController } from './venues.controller.js';
import { CatalogTransactionsModule } from '../catalog-transactions.js';

@Module({
  imports: [CatalogTransactionsModule],
  controllers: [VenuesController],
  providers: [CreateVenueHandler],
})
export class VenuesModule {}
