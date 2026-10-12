import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { DevicesController } from './devices.controller.js';
import { CLOCK } from '../clock.js';
import { IdentityModule } from '../identity/identity.module.js';

/** The viewer's devices and device sessions, ended at identity. */
@Module({
  imports: [IdentityModule],
  controllers: [DevicesController],
  providers: [{ provide: CLOCK, useValue: new SystemClock() }],
})
export class DevicesModule {}
