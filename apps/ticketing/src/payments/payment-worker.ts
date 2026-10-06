import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import { SweeperLoop } from '../sweeper-loop.js';

const PAYMENT_WORKER_EVERY_MS = 1_000;
export const PAYMENT_WORKER_BATCH = 100;

/**
 * The webhooks recorded, applied in the API process on Postgres alone (HANDOVER §0j). Each pass
 *   counts only what it settled, so a batch of failures waits for the next tick. The calls owed to
 *   the provider are the worker process's queues (§0m): no request path and no pass here calls
 *   Redis or the provider.
 */
@Injectable()
export class PaymentWorker extends SweeperLoop {
  protected readonly logger = new Logger(PaymentWorker.name);

  public constructor(private readonly commands: CommandBus) {
    super(PAYMENT_WORKER_EVERY_MS, PAYMENT_WORKER_BATCH);
  }

  protected pass(): Promise<number> {
    return this.commands.execute(new ApplyPaymentEvents(PAYMENT_WORKER_BATCH));
  }
}
