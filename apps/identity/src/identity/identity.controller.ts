import { Body, Controller, Header, HttpCode, Headers, Post } from '@nestjs/common';

import { RegisterAccountService } from './register-account.service.js';

interface RegisterBody {
  publicHandle: string;
  email: string;
  locale: string;
  country: string;
}

@Controller('accounts')
export class IdentityController {
  constructor(private readonly registerAccount: RegisterAccountService) {}

  @Post()
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  async register(
    @Body() body: RegisterBody,
    @Headers('traceparent') traceparent?: string,
  ): Promise<{ accountId: string }> {
    // ⚠ The incoming traceparent is taken as given and carried through. It is
    //   not validated here because a malformed one must not fail a
    //   registration: a broken trace is an observability fault, never a
    //   business one.
    const result = await this.registerAccount.register({
      publicHandle: body.publicHandle,
      email: body.email,
      locale: body.locale,
      country: body.country,
      traceparent: traceparent ?? null,
    });
    return { accountId: result.accountId };
  }
}
