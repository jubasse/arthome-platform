import { z } from 'zod';

import { SeatCancelReason } from '@arthome/core';
import { vocabularyIn } from '@arthome/core/schema';

/** The storefront's `cancelSeat` body, which may be absent: the one reason a viewer gives. */
export const CancelSeatSchema = z
  .strictObject({
    cancelReasonCode: vocabularyIn([SeatCancelReason.VIEWER_REQUEST]).optional(),
  })
  .optional();

export type CancelSeatBody = z.infer<typeof CancelSeatSchema>;
