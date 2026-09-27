import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { ArtistsController } from './artists.controller.js';
import { UpdateChannelIdentityHandler } from './update-channel-identity.handler.js';
import { CatalogTransactionsModule } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';

@Module({
  imports: [CatalogTransactionsModule],
  controllers: [ArtistsController],
  providers: [UpdateChannelIdentityHandler, { provide: CLOCK, useValue: new SystemClock() }],
})
export class ArtistsModule {}
