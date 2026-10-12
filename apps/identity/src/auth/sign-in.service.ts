import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isAPIError } from 'better-auth/api';
import { DataSource } from 'typeorm';

import { Account } from './account.entity.js';
import { BETTER_AUTH } from './auth.tokens.js';
import type { Auth } from './better-auth.js';
import { hashPassword, isOutdated } from './password-hashing.js';
import { invalidCredentials } from './refusals.js';
import { SessionsService } from './sessions.service.js';
import type { SignInBody } from './sign-up.schema.js';
import type { SignedUp } from './sign-up.service.js';
import { DevicesService } from '../devices/devices.service.js';
import type { PresentedDevice } from '../devices/presented-device.schema.js';
import { defaultProfileOf } from '../profiles/default-profile.js';

/**
 * better-auth checks the password (and hashes one for an unknown address too, so the two take the
 *   same time); identity then checks the account may sign in. Every refusal is the same 401. A
 *   digest made with older parameters is hashed again while the password is at hand (rule 8). Only
 *   then is the device registered or its token rotated, and the session bound: a wrong password
 *   writes no device.
 */
@Injectable()
export class SignInService {
  public constructor(
    @Inject(BETTER_AUTH) private readonly auth: Auth,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: SessionsService,
    private readonly devices: DevicesService,
  ) {}

  public async signIn(body: SignInBody, presented: PresentedDevice): Promise<SignedUp> {
    let signedIn;
    try {
      signedIn = await this.auth.api.signInEmail({
        body: { email: body.email, password: body.password },
        returnHeaders: true,
      });
    } catch (error) {
      if (isAPIError(error) && error.statusCode === 401) throw invalidCredentials();
      throw error;
    }
    const token = signedIn.headers.get('set-auth-token');
    if (token === null) throw new Error('better-auth opened a session and handed no token');

    const account = await this.dataSource.manager.findOneBy(Account, {
      id: signedIn.response.user.id,
    });
    if (account === null || !this.sessions.isAllowedToSignIn(account)) {
      await this.sessions.revoke(token);
      throw invalidCredentials();
    }
    await this.rehashIfOutdated(account.id, body.password);
    const opened = await this.sessions.opened(token);
    const { session, deviceToken } = await this.sessions.bindInTransaction(
      opened,
      async (manager) => {
        const profile = await defaultProfileOf(manager, account.id);
        const device = await this.devices.deviceFor(manager, presented);
        const established = await this.sessions.establish(
          manager,
          opened,
          device.deviceId,
          profile,
        );
        return { ...established, deviceToken: device.token };
      },
    );
    return {
      session,
      device: { token: deviceToken },
      account: {
        publicHandle: account.public_handle,
        emailVerified: account.email_verified_at !== null,
      },
    };
  }

  private async rehashIfOutdated(accountId: string, password: string): Promise<void> {
    const context = await this.auth.$context;
    const credential = await context.internalAdapter.findCredentialAccount(accountId);
    if (credential?.password && isOutdated(credential.password)) {
      await context.internalAdapter.updatePassword(accountId, await hashPassword(password));
    }
  }
}
