import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { OwedRefunds } from './owed-refunds.js';
import { RefundOwedPayments } from './refund-owed-payments.command.js';

@CommandHandler(RefundOwedPayments)
export class RefundOwedPaymentsHandler implements ICommandHandler<RefundOwedPayments> {
  public constructor(private readonly refunds: OwedRefunds) {}

  public execute({ batch }: RefundOwedPayments): Promise<number> {
    return this.refunds.refundDue(batch);
  }
}
