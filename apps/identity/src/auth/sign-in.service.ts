import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isAPIError } from 'better-auth/api';
import { DataSource } from 'typeorm';

import { Account } from './account.entity.js';
import { BETTER_AUTH } from './auth.tokens.js';
import type { Auth } from './better-auth.js';
import { invalidCredentials } from './refusals.js';
import { SessionsService } from './sessions.service.js';
import type { SignInBody } from './sign-up.schema.js';
import type { SignedUp } from './sign-up.service.js';

/**
 * better-auth checks the password (and hashes one for an unknown address too, so the two take the
 *   same time); identity then checks the account may sign in. Every refusal is the same 401.
 */
@Injectable()
export class SignInService {
  public constructor(
    @Inject(BETTER_AUTH) private readonly auth: Auth,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: SessionsService,
  ) {}

  public async signIn(body: SignInBody): Promise<SignedUp> {
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
    return {
      session: await this.sessions.established(token),
      account: {
        publicHandle: account.public_handle,
        emailVerified: account.email_verified_at !== null,
      },
    };
  }
}
