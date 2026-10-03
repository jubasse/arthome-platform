import type { IncomingHttpHeaders } from 'node:http';

import { parseTraceparent, schemaInvalidException } from '@arthome-platform/http-edge';
import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { type PaymentWebhookPort } from '@arthome/core';

import { PAYMENT_WEBHOOK_PORT } from './payment-tokens.js';
import { RecordPaymentEvent, type PaymentEventReceipt } from './record-payment-event.command.js';

/** What `rawBody: true` leaves on a request (`nestjs-http` rule 13). */
interface RawBodyRequest {
  readonly rawBody?: Buffer;
  readonly headers: IncomingHttpHeaders;
}

function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * The payment provider's webhooks. The raw bytes, never the parsed body: a reformatted body no
 *   longer matches its signature (adr-payments.md §7.1). No body schema, since the signature is
 *   checked before anything is read.
 */
@Controller('v1/payments')
export class PaymentWebhooksController {
  public constructor(
    private readonly commands: CommandBus,
    @Inject(PAYMENT_WEBHOOK_PORT) private readonly webhooks: PaymentWebhookPort,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  public receive(@Req() request: RawBodyRequest): Promise<PaymentEventReceipt> {
    // Fails closed: without `rawBody: true` at bootstrap there are no bytes to verify.
    if (request.rawBody === undefined) throw schemaInvalidException([]);
    return this.commands.execute(
      new RecordPaymentEvent(
        request.rawBody,
        headerOf(request.headers, this.webhooks.signatureHeader),
        parseTraceparent(headerOf(request.headers, 'traceparent'))?.traceparent ?? null,
      ),
    );
  }
}
