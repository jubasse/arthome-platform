import { parseTraceparent } from '@arthome-platform/http-edge';
import { Body, Controller, Header, HttpCode, Headers, Post } from '@nestjs/common';

import { RegisterAccountSchema, type RegisterAccountBody } from './register-account.schema.js';
import { RegisterAccountService } from './register-account.service.js';

@Controller('accounts')
export class IdentityController {
  public constructor(private readonly registerAccount: RegisterAccountService) {}

  @Post()
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  public async register(
    @Body({ schema: RegisterAccountSchema }) body: RegisterAccountBody,
    @Headers('traceparent') traceparent?: string,
  ): Promise<{ publicHandle: string }> {
    // By hand because no pipe reaches a header (see `traceparent.ts`). A malformed one is
    //   dropped rather than refused — a broken trace is not a business fault.
    const trace = parseTraceparent(traceparent);

    await this.registerAccount.register({
      publicHandle: body.publicHandle,
      email: body.email,
      locale: body.locale,
      country: body.country,
      traceparent: trace === null ? null : trace.traceparent,
    });

    // Never the account id: a UUIDv7 reveals its own creation instant and is orderable
    //   (data-model.md §7.1). `public_handle` is what a surface is given.
    return { publicHandle: body.publicHandle };
  }
}
