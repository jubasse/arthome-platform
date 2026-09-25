import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CatalogModule } from './catalog/catalog.module.js';
import { dataSource } from './data-source.js';

@Module({
  imports: [TypeOrmModule.forRoot(dataSource.options), CatalogModule],
})
export class AppModule {}
