import { Inject, Injectable } from '@nestjs/common';

import { Service } from '@arthome/core';

import {
  AddressVerifiedSchema,
  SessionOpenedSchema,
  SessionResolvedSchema,
  SignedOutSchema,
  VerificationSentSchema,
  ViewerAnswerSchema,
  type ResolvedSession,
  type SessionOpened,
  type ViewerAccount,
} from './identity-answers.schema.js';
import { InternalTokenMinter } from '../internal-token.minter.js';
import { ServiceClient, type ServiceAnswer, type ServiceCall } from '../upstream/service-client.js';

export const IDENTITY_URL: unique symbol = Symbol('IdentityUrl');

/** What the BFF sends identity at sign-up: the contract's body, the country it resolved. */
export interface SignUpRequest {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
  readonly locale: string;
  readonly country: string;
  readonly acceptedTermsVersion: number;
}

/**
 * The adapter to identity (`adr-auth.md` §8.2): the relayed authentication calls, and the session
 *   this BFF validates on every call that needs a viewer. A session token rides in a body, never in a
 *   header: `authorization` carries this BFF's own token.
 */
@Injectable()
export class IdentityClient {
  private readonly client: ServiceClient;

  public constructor(@Inject(IDENTITY_URL) baseUrl: string, minter: InternalTokenMinter) {
    this.client = new ServiceClient(Service.IDENTITY, baseUrl, minter);
  }

  public async signUp(
    body: SignUpRequest,
    idempotencyKey: string,
    call: ServiceCall,
  ): Promise<ServiceAnswer<SessionOpened>> {
    const answer = await this.client.request(
      {
        method: 'POST',
        path: '/v1/auth/sign-up',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      },
      call,
      SessionOpenedSchema,
    );
    return { body: answer.body.data, replayed: answer.replayed };
  }

  public async signIn(email: string, password: string, call: ServiceCall): Promise<SessionOpened> {
    const answer = await this.client.request(
      { method: 'POST', path: '/v1/auth/sign-in', body: { email, password } },
      call,
      SessionOpenedSchema,
    );
    return answer.body.data;
  }

  /** Null for a token that opens nothing: expired, revoked, forged, or its account suspended. */
  public async resolve(token: string, call: ServiceCall): Promise<ResolvedSession | null> {
    const answer = await this.client.request(
      { method: 'POST', path: '/v1/sessions/resolve', body: { token } },
      call,
      SessionResolvedSchema,
    );
    return answer.body.data.session;
  }

  public async revoke(token: string, call: ServiceCall): Promise<void> {
    await this.client.request(
      { method: 'POST', path: '/v1/sessions/revoke', body: { token } },
      call,
      SignedOutSchema,
    );
  }

  public async viewer(call: ServiceCall): Promise<ViewerAccount> {
    const answer = await this.client.request(
      { method: 'GET', path: '/v1/accounts/me' },
      call,
      ViewerAnswerSchema,
    );
    return answer.body.data;
  }

  public async resendVerification(
    idempotencyKey: string,
    call: ServiceCall,
  ): Promise<ServiceAnswer<{ readonly sent: boolean }>> {
    const answer = await this.client.request(
      {
        method: 'POST',
        path: '/v1/accounts/me/email-verification',
        headers: { 'idempotency-key': idempotencyKey },
      },
      call,
      VerificationSentSchema,
    );
    return { body: answer.body.data, replayed: answer.replayed };
  }

  public async confirmVerification(
    token: string,
    idempotencyKey: string,
    call: ServiceCall,
  ): Promise<ServiceAnswer<{ readonly verified: boolean }>> {
    const answer = await this.client.request(
      {
        method: 'POST',
        path: '/v1/email-verifications/confirm',
        body: { token },
        headers: { 'idempotency-key': idempotencyKey },
      },
      call,
      AddressVerifiedSchema,
    );
    return { body: answer.body.data, replayed: answer.replayed };
  }
}
