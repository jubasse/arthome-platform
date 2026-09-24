import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { dataSource } from './data-source.js';
import { IdentityModule } from './identity/identity.module.js';

@Module({
  imports: [TypeOrmModule.forRoot(dataSource.options), IdentityModule],
})
export class AppModule {}
