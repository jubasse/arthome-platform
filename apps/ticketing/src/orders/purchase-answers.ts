import type { SuccessEnvelope } from '@arthome-platform/http-edge';
import type { EntityManager } from 'typeorm';

import type { PaymentHandoffView, PurchasedSeats } from './order-views.js';
import type { PurchaseStatus } from './purchase-seat.command.js';

export interface StoredAnswer {
  readonly status: PurchaseStatus;
  readonly envelope: SuccessEnvelope<PurchasedSeats | PaymentHandoffView>;
}

/**
 * The first answer a purchase served, which a replay under its key serves again verbatim
 *   (transport.md §5.4): `json`, not `jsonb`, keeps its bytes. A refusal is not kept; the order's
 *   state answers it again.
 */
export async function storedAnswerOf(
  manager: EntityManager,
  orderId: string,
): Promise<StoredAnswer | null> {
  const [row] = await manager.query<
    { answer_status: PurchaseStatus | null; answer_body: unknown }[]
  >('SELECT answer_status, answer_body FROM seat_order WHERE id = $1', [orderId]);
  if (row?.answer_status == null) return null;
  return {
    status: row.answer_status,
    envelope: row.answer_body as SuccessEnvelope<PurchasedSeats | PaymentHandoffView>,
  };
}

/** False when the order already kept one: two attempts under one key resumed it together. */
export async function storeAnswer(
  manager: EntityManager,
  orderId: string,
  { status, envelope }: StoredAnswer,
): Promise<boolean> {
  const [, affected] = await manager.query<[unknown, number]>(
    `UPDATE seat_order SET answer_status = $2, answer_body = $3
      WHERE id = $1 AND answer_status IS NULL`,
    [orderId, status, JSON.stringify(envelope)],
  );
  return affected === 1;
}
