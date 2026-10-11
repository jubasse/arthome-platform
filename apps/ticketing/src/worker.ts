import 'reflect-metadata';

import { ShutdownSignal } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule, {
  logger: ['warn', 'error'],
});
// `useProcessExit`: once the jobs in flight and the relay's pass have committed and the pool
//   closed, exit 0.
app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT], { useProcessExit: true });
