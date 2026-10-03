import 'reflect-metadata';

import { ShutdownSignal } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { SweeperModule } from './sweeper.module.js';

const app = await NestFactory.createApplicationContext(SweeperModule, {
  logger: ['warn', 'error'],
});
// `useProcessExit`: once the pass in flight has committed and the pool closed, exit 0.
app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT], { useProcessExit: true });
