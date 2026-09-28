import { RefusalException, schemaInvalidException } from '@arthome-platform/http-edge';
import { HttpStatus, Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ApiErrorCode, FailureNature, type Clock } from '@arthome/core';

import { PaymentWebhookPort } from './payment.port.js';
import { RecordPaymentEvent, type PaymentEventReceipt } from './record-payment-event.command.js';
import { CLOCK } from '../clock.js';

/**
 * adr-ticketing.md §8: verified on the raw bytes, recorded unique on the provider's event id, and
 *   answered at once; the payment worker applies it. A signature that does not cover the bytes is
 *   401, nothing recorded; signed bytes that are no event are 400. A duplicate is a 2xx like the
 *   first, since the provider retries until it gets one.
 */
@CommandHandler(RecordPaymentEvent)
export class RecordPaymentEventHandler implements ICommandHandler<RecordPaymentEvent> {
  public constructor(
    private readonly webhooks: PaymentWebhookPort,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({
    rawBody,
    signature,
    traceparent,
  }: RecordPaymentEvent): Promise<PaymentEventReceipt> {
    if (!this.webhooks.verifySignature(rawBody, signature, this.clock.now())) {
      throw new RefusalException(HttpStatus.UNAUTHORIZED, {
        code: ApiErrorCode.UNAUTHENTICATED,
        params: {},
        nature: FailureNature.REFUSED,
      });
    }
    const event = this.webhooks.parse(rawBody);
    if (event === null) throw schemaInvalidException([]);
    const inserted = await this.dataSource.query<unknown[]>(
      `INSERT INTO stripe_event_inbox
              (event_id, kind, intent_ref, order_id, decline_code, occurred_at, payload, traceparent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        event.eventId,
        event.kind,
        event.intentRef,
        event.orderId,
        event.declineCode,
        new Date(event.occurredAt),
        rawBody,
        traceparent,
      ],
    );
    return { eventId: event.eventId, duplicate: inserted.length === 0 };
  }
}
