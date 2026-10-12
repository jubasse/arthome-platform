## 2. What T4 inherits

What T3 inherited from T2 is built: the hot decrement (`takeSeats`) and `seats_sold`'s statement
(§0h), the unlocked load (`findUnlocked`), the stored snapshot moved with the decrement, the key on
`seat_order` alone (libs review L1), the hold expiry beside the publisher (§0i), and the closing
of sales by time, thirty minutes after the start (D-089, §0l). Topics `arthome.ticketing.order` (6,
`order_id`) and `.account` (3) are provisioned, and `order.paid` and `order.refunded` now reach the
first.

- ~~Refunds on a cancelled date~~, credits on an interrupted one: built (PT1, §0n), the orders paid
  through a hold active at the cancellation included.
- ~~The provider calls on BullMQ~~: built (PT0, §0m), in a fourth process, the worker; refunds are
  `order_refund` rows, several per order, and `partially_refunded` is the ledger's.
- ~~`cancelSeat` and `refundSeat`~~, ~~`seat.cancelled` and `SeatState` beyond `active`~~: built
  (PT2, §0o), owing their refunds through `SeatOrder.oweRefund` (§0m); `refundReasonCode` is served
  on `refunded` and `partially_refunded`.
- **The race suite of adr-ticketing.md §12**: a duplicated and an out-of-order webhook, a success
  after the hold expired, declines and an abandoned action are proven (`payment-webhooks.itest.ts`,
  `purchase.itest.ts`); a chargeback (`disputed`) is applied (§0o); a refund racing a payment, and
  the races over `cancelSeat`, are PT4's.
- **A Stripe adapter** implements the two ports:
  - an intent already succeeded is a cancellation that succeeded (`cancelIntent` is best effort),
    and a refund retried past Stripe's 24 h key retention, answered `charge_already_refunded`, is a
    refund made; that holds for D-082's refund of the whole payment alone;
  - **past the key's 24 hours, a refund is looked up before it is sent again** (the review's S4).
    Stripe forgets the key then, so a partial refund (PT1, PT2) asked again would be made a second
    time. The automatic attempts stay inside the window (`REFUND_RETRIES_WITHIN_MS`, 23 h; a lost
    job is given up, not enqueued again, §0m). What can still cross it is §0k's replay of a dead
    refund: until the adapter does it, the operator looks the refund up at the provider by our
    refund id, and the adapter, sending our refund id in the refund's metadata, looks it up there
    before creating one whenever the row was owed more than the window ago (D-098: not this
    slice);
  - a renewed hold moves the order's `expiresAt` before `createIntent` is asked again under the same
    order id, and Stripe refuses a key reused with other parameters: the adapter keeps the expiry
    out of the idempotent request, or sends the first one;
  - the intent is re-read from Stripe when a webhook leaves doubt (adr-payments.md §7.3, not built
    here);
  - ~~its request timeout below the claim's 5 s lease~~: gone with the claims (§0m), a job's lock
    being renewed while its worker lives; its timeout bounds a job, and the grace period covers it;
  - Stripe's 429 sets the queue's limit (`queue.rateLimit`, then `throw Worker.RateLimitError()`,
    no attempt consumed), and the limits of §0m are revisited against the live account's;
  - the webhook route, refused in production like every write, is exempted once its signature is
    Stripe's.
- **Lifting `DenyInProductionGuard` needs a real adapter bound first**: the fake confirms every
  intent without taking any money, so `payments.module.ts` refuses to bind it in production and the
  API and the worker fail at boot there (`payments.module.spec.ts`, the architecture review's P1).
  The consumer and the sweeper import no payment port and boot. The real adapter lifts both locks: the boot refusal,
  and `DenyInProductionGuard` on `OrdersController` and `PaymentWebhooksController`.
- ~~A postponement moves the seats' cancel deadline~~: built (PT1, §0n), with no event of its own;
  a payment racing the postponement is §0n's window left.
- ~~A late payment on a date since cancelled~~: refunded `date_cancelled`, with no seat (D-097,
  §0n).
- For T6: the TV pairing's hold (`SeatHoldOrigin.PAIRING`) has no order; the expiry pass joins each
  hold to its order, so a pairing hold needs its own branch there. The expiry's cost under load is
  the load test's.

