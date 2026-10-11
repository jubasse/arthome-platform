import type { EntityManager } from 'typeorm';

export interface SeatOwner {
  readonly orderId: string;
  readonly accountId: string | null;
}

/**
 * The order a seat belongs to, read without a lock: the order is locked next, before its seats,
 *   its refunds and the date's row (HANDOVER §0h's lock order).
 */
export async function seatOwnerOf(
  manager: EntityManager,
  seatId: string,
): Promise<SeatOwner | null> {
  const [owner] = await manager.query<{ order_id: string; account_id: string | null }[]>(
    'SELECT order_id, account_id FROM seat WHERE id = $1',
    [seatId],
  );
  return owner === undefined ? null : { orderId: owner.order_id, accountId: owner.account_id };
}
