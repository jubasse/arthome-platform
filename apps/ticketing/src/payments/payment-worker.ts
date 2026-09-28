import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import { CancelOwedIntents } from './cancel-owed-intents.command.js';
import { RefundOwedPayments } from './refund-owed-payments.command.js';
import { SweeperLoop } from '../sweeper-loop.js';

const PAYMENT_WORKER_EVERY_MS = 1_000;
/** Per kind of work, per pass. */
export const PAYMENT_WORKER_BATCH = 100;

/**
 * The work that follows a payment, in the API process: it needs Postgres and the provider, which
 *   the API already needs, and the sweeper stays on Postgres alone. The webhooks recorded, then the
 *   refunds owed, then the intents to cancel, each pass. T4 moves the provider calls onto its queue.
 */
@Injectable()
export class PaymentWorker extends SweeperLoop {
  protected readonly logger = new Logger(PaymentWorker.name);

  public constructor(private readonly commands: CommandBus) {
    super(PAYMENT_WORKER_EVERY_MS, PAYMENT_WORKER_BATCH);
  }

  protected async pass(): Promise<number> {
    const applied = await this.commands.execute(new ApplyPaymentEvents(PAYMENT_WORKER_BATCH));
    const refunded = await this.commands.execute(new RefundOwedPayments(PAYMENT_WORKER_BATCH));
    const cancelled = await this.commands.execute(new CancelOwedIntents(PAYMENT_WORKER_BATCH));
    return Math.max(applied, refunded, cancelled);
  }
}
