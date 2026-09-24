import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Account } from './account.entity.js';
import { IdentityController } from './identity.controller.js';
import { OutboxEvent } from './outbox-event.entity.js';
import { RegisterAccountService } from './register-account.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Account, OutboxEvent])],
  controllers: [IdentityController],
  providers: [RegisterAccountService],
})
export class IdentityModule {}
