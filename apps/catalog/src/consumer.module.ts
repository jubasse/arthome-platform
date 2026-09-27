import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { dataSource } from './data-source.js';
import { ChecklistConsumerModule } from './dates/checklist-consumer.module.js';

@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    ChecklistConsumerModule,
  ],
})
export class ConsumerModule {}
