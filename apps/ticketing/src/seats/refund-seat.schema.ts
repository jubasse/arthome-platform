import { z } from 'zod';

import { RefundReason } from '@arthome/core';
import { vocabularyIn } from '@arthome/core/schema';

/** The studio's `refundSeat` body: the four reasons an operator chooses, an amount or the seat's share. */
export const RefundSeatSchema = z.strictObject({
  refundReasonCode: vocabularyIn([
    RefundReason.DATE_CANCELLED,
    RefundReason.GOODWILL,
    RefundReason.DUPLICATE,
    RefundReason.DISPUTE,
  ]),
  partialAmountMinor: z.int().min(1).nullable().optional(),
});

export type RefundSeatBody = z.infer<typeof RefundSeatSchema>;
