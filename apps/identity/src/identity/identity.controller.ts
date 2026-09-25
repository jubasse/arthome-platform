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
    // ⚠ THE HEADER IS CHECKED HERE AND THE BODY IS NOT, AND THAT IS NOT AN
    //   INCONSISTENCY. `@Body({ schema })` carries a schema the global
    //   `StandardSchemaValidationPipe` finds; `@Headers` takes no options object at
    //   all — verified in the installed `@nestjs/common` 12.0.3, where it is
    //   declared `(property?: string) => ParameterDecorator` — so no pipe can ever
    //   see it. A header is validated by hand or not at all.
    //
    // ⚠ AND A MALFORMED ONE DOES NOT FAIL THE REQUEST. That is decided, and the
    //   decision is what this line keeps: a broken trace is an observability
    //   fault, never a business one. `parseTraceparent` returns `null` instead of
    //   throwing, so a wrong value is dropped rather than carried into
    //   `outbox_event.tracecontext` — the one outbox column with no CHECK
    //   constraint, and from there into a Kafka header and into
    //   `notifications.welcome_email`.
    const trace = parseTraceparent(traceparent);

    await this.registerAccount.register({
      publicHandle: body.publicHandle,
      email: body.email,
      locale: body.locale,
      country: body.country,
      traceparent: trace === null ? null : trace.traceparent,
    });

    // ⚠ THE ACCOUNT ID IS NOT RETURNED, AND IT USED TO BE. `account.entity.ts`
    //   says of the primary key "UUIDv7, never exposed", and `data-model.md` §7.1
    //   gives the reason: a UUIDv7 reveals its own creation instant and is
    //   orderable, so handing one out leaks when an account was created and lets a
    //   holder of two of them order the population. `public_handle` is the
    //   identifier a surface is given — and the caller already sent it, so nothing
    //   is lost by echoing it back rather than the internal key.
    return { publicHandle: body.publicHandle };
  }
}
