import {
  AllowInProduction,
  CurrentPrincipal,
  accountOf,
  idempotencyKeyOf,
  idempotentRequestOf,
  keyedFingerprintOf,
  parseTraceparent,
  type MemorisedResponse,
  type Principal,
} from '@arthome-platform/http-edge';
import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Post } from '@nestjs/common';

import { FINGERPRINT_KEY } from './auth.tokens.js';
import { EmailVerificationsService } from './email-verifications.service.js';
import { SessionsService, type ResolvedViewer } from './sessions.service.js';
import { SignInService } from './sign-in.service.js';
import {
  SessionTokenSchema,
  SignInSchema,
  SignUpSchema,
  TokenSchema,
  type SessionTokenBody,
  type SignInBody,
  type SignUpBody,
  type TokenBody,
} from './sign-up.schema.js';
import { SignUpService, type SignedUp } from './sign-up.service.js';
import { ViewerService, type Viewer } from './viewer.service.js';

const SIGN_UP_PATH = '/v1/auth/sign-up';

/**
 * The storefront BFF's calls (`adr-auth.md` §8.2): every one behind the internal token, none of
 *   them a better-auth route. Session tokens travel in bodies: `authorization` carries the BFF's
 *   token, and a session token in a header of its own would reach access logs.
 */
@AllowInProduction()
@Controller('v1')
export class AuthController {
  public constructor(
    private readonly signUps: SignUpService,
    private readonly signIns: SignInService,
    private readonly sessions: SessionsService,
    private readonly verifications: EmailVerificationsService,
    private readonly viewers: ViewerService,
    @Inject(FINGERPRINT_KEY) private readonly fingerprintKey: string,
  ) {}

  /** The fingerprint is keyed: the body carries a password, and the record keeps it for a day. */
  @Post('auth/sign-up')
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  public signUp(
    @Body({ schema: SignUpSchema }) body: SignUpBody,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<SignedUp>> {
    return this.signUps.signUp(
      body,
      {
        key: idempotencyKeyOf(idempotencyKey),
        accountId: null,
        fingerprint: keyedFingerprintOf(this.fingerprintKey, 'POST', SIGN_UP_PATH, body),
        statusCode: 201,
      },
      parseTraceparent(traceparent)?.traceparent ?? null,
    );
  }

  /** No idempotency, by the contract's prohibition: a replay would open a session unchecked. */
  @Post('auth/sign-in')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public signIn(@Body({ schema: SignInSchema }) body: SignInBody): Promise<SignedUp> {
    return this.signIns.signIn(body);
  }

  @Post('sessions/resolve')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public async resolve(
    @Body({ schema: SessionTokenSchema }) body: SessionTokenBody,
  ): Promise<{ readonly session: ResolvedViewer | null }> {
    return { session: await this.sessions.resolve(body.token) };
  }

  /** Revoking a session already gone succeeds: the contract's sign-out replays as a success. */
  @Post('sessions/revoke')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public async revoke(
    @Body({ schema: SessionTokenSchema }) body: SessionTokenBody,
  ): Promise<{ readonly signedOut: true }> {
    await this.sessions.revoke(body.token);
    return { signedOut: true };
  }

  @Get('accounts/me')
  @Header('cache-control', 'no-store')
  public me(@CurrentPrincipal() principal: Principal): Promise<Viewer> {
    return this.viewers.viewer(accountOf(principal));
  }

  @Post('accounts/me/email-verification')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public resendVerification(
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<{ readonly queued: boolean }>> {
    const accountId = accountOf(principal);
    return this.verifications.resend(
      accountId,
      idempotentRequestOf(
        'POST',
        '/v1/accounts/me/email-verification',
        {},
        200,
        idempotencyKey,
        accountId,
      ),
      parseTraceparent(traceparent)?.traceparent ?? null,
    );
  }

  @Post('email-verifications/confirm')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public confirmVerification(
    @Body({ schema: TokenSchema }) body: TokenBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MemorisedResponse<{ readonly verified: true }>> {
    return this.verifications.confirm(
      body.token,
      idempotentRequestOf(
        'POST',
        '/v1/email-verifications/confirm',
        body,
        200,
        idempotencyKey,
        null,
      ),
    );
  }
}
