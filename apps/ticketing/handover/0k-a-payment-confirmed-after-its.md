## 0k. A payment confirmed after its hold expired (T3, D-082)

`orders/settle-payment.ts`, shared by tx B and the webhook worker. A confirmation for an order that
can still take a payment consumes its hold while that hold is active, even past its instant if the
sweeper has not reached it. When the hold is gone (expired, released), the seats are taken again
by `takeAndSellSeats`: `seats_available - q` and `seats_sold + q` in one statement, conditioned on
`on_sale AND seats_available >= q`. The order is then paid as any other, its failure cleared and
its owed cancellation dropped.

With none left, the order owes the money back (`SeatOrder.oweUnseatedPaymentBack`,
`hold_expired_capacity_lost`): one `order_refund` row of the whole total under its own key,
`refundIdempotencyKey(refundId)`,
written in the same transaction with the trace it was found under (`recordRefundTraceparent`), no
seat created, nothing sold, nothing asked of the provider. The worker's relay enqueues it within its
next second, the refund queue asks the provider under that key outside any transaction, then marks
the order `refunded` with `order.refunded` (`refund_reason` `HOLD_EXPIRED_CAPACITY_LOST`, no seat
cancelled) under that trace (§0m). The first try at once that T3 made from the purchase and the
webhook worker is dropped by choice (PT0 O3): one path for every call, under the limiter, within the
relay's second. Never an oversold date, never money kept without a seat. `payouts` receives this
`order.refunded` for an order it never saw `order.paid`.

**Replaying a call given up on.** After its schedule's failed attempts, or its job stalled past its
bound or lost (§0m), the refund is marked `dead_at` and
an error is logged: "the buyer's money is held without a seat until an operator replays the refund".
`pnpm run ops:check ticketing` reports it, `provider_calls_dead` degraded with the replay statement
in its detail; one on a disputed order is counted apart, `refundsHeldByDisputes`, and degrades
nothing, since it is never replayed (below; the PT1 review's F2). Find them with `SELECT id, order_id, idempotency_key, owed_at, dead_at FROM
order_refund WHERE dead_at IS NOT NULL AND refunded_at IS NULL`. Once the cause is gone (the
provider's incident over, or the refusal understood and settled at the provider), and **once the
refund is looked up at the provider by its refund id**, which past the key's 24 hours alone tells
whether it was made (§2), replay one with:

```sql
UPDATE order_refund SET dead_at = NULL, enqueued_at = NULL
 WHERE id = '<refund id>' AND dead_at IS NOT NULL;
```

The relay enqueues it again within a second, its schedule anew, under the same key, so a refund the
provider made meanwhile is not made twice, and the order is then `refunded` with its
`order.refunded`. Do not replay a refund whose order is `disputed`: its error says the dispute
holds the buyer's money, which the dispute gives back if the buyer wins it, so a replay could pay
them twice, and the processor gives it up again before any call (§0o). Owed still after a dispute
the merchant won, it is a manual case until a dispute's close reaches the platform (no event for it
yet). An intent's cancellation is
replayed the same way, `UPDATE seat_order SET intent_cancel_dead_at = NULL,
intent_cancel_enqueued_at = NULL WHERE id = '<order id>' AND intent_cancel_dead_at IS NOT NULL`,
which is only worth it while the intent could still be confirmed.

A purchase replayed under its key once its hold expired, never having reached the provider,
answers `order.sold_out` from the failed order and asks the provider nothing.

