import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { AuthController, VIEWER_COUNTRY_HEADER } from './auth.controller.js';
import { FailedSignIns, PAUSE, pauseFor } from './failed-sign-ins.js';
import { ThrottlerRedisModule } from './throttler-storage.js';
import { CLOCK } from '../clock.js';
import { authEnv } from '../env.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ViewerContextController } from '../viewer-context/viewer-context.controller.js';

/** The storefront's authentication relay and the viewer's bootstrap, both served by identity. */
@Module({
  imports: [IdentityModule, ThrottlerRedisModule],
  controllers: [AuthController, ViewerContextController],
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: VIEWER_COUNTRY_HEADER, useValue: authEnv.viewerCountryHeader },
    { provide: PAUSE, useValue: pauseFor },
    FailedSignIns,
  ],
})
export class AuthModule {}
