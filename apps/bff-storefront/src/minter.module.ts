import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { CLOCK } from './clock.js';
import { authEnv } from './env.js';
import { InternalTokenMinter, SIGNING_KEY } from './internal-token.minter.js';

/** One minter per process, so its imported key is shared by every client. */
@Module({
  providers: [
    InternalTokenMinter,
    { provide: SIGNING_KEY, useValue: authEnv.signingKey },
    { provide: CLOCK, useValue: new SystemClock() },
  ],
  exports: [InternalTokenMinter],
})
export class MinterModule {}
