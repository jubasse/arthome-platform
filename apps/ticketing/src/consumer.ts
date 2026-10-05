import 'reflect-metadata';

import { ShutdownSignal } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ConsumerModule } from './consumer.module.js';

const app = await NestFactory.createApplicationContext(ConsumerModule, {
  logger: ['warn', 'error'],
});
// `useProcessExit`: once closed, exit 0 rather than re-raise the signal.
app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT], { useProcessExit: true });
