import { Module } from '@nestjs/common';

import { IDENTITY_URL, IdentityClient } from './identity.client.js';
import { authEnv } from '../env.js';
import { MinterModule } from '../minter.module.js';

@Module({
  imports: [MinterModule],
  providers: [IdentityClient, { provide: IDENTITY_URL, useValue: authEnv.identityUrl }],
  exports: [IdentityClient],
})
export class IdentityModule {}
