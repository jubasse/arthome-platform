## 0o. A seat's cancellation and refund, and the provider's refund and dispute webhooks (T4, PT2)

`src/seats/` and the seat parts of `orders/`; `1790441350000-seat-states.ts` (processes stopped).

- **A seat leaves `active`** by core's `seatStateMayMove`: `cancelled` when its cancellation is
  decided, with `ended_at`, `cancel_reason`, its refund and its share (`refund_id`,
  `refund_amount_minor`); `refunded` once that refund is made (`SeatOrder.refundMade`, from the
  processor's answer or a refund webhook, whichever comes first); `credited` with its credit and
  share (`credit_id`, `credit_amount_minor`; PT1, whose `credit` table takes the foreign key). A
  seat no longer active is refused 409 `seat.not_active` with its `state`. CHECKs: `ended_at` null
  exactly while active, each amount with its id, a refund's share above zero and a credit's at
  zero or more (a credit split over more seats than its minor units still credits each seat, §0n).
- **The seam PT1 calls**: `SeatOrder.cancelSeats({ reason, refundId, seats: [{ seatId,
  refundAmount }] }, now)` and `creditSeats({ creditId, seats: [{ seatId, creditAmount }] }, now)`.
  The refund is one the order owes, a share of nothing is recorded as nothing given back (the seat
  stays `cancelled` for good), a negative share is refused, and the shares, with those the order's
  seats already hold under that refund over earlier calls, stay within it. Either refuses before
  anything moves.
- **The wire**: one `ticketing.seat.cancelled.v1` per seat cancelled, on
  `arthome.ticketing.date_sales` keyed by the date (`seat_id`, `date_id`, the seat's `account_id`,
  `reason` through `WIRE_SEAT_CANCEL_REASON`, never `PAYMENT_FAILED`), in the transaction that saves
  the order, for streaming's entitlements and payouts. A credit reaches no wire (`SeatsCredited`,
  D-092). `order.refunded`'s `reason` is `seatCancelReasonOf` of its refund's, `UNSPECIFIED` for a
  refund that cancels no seat (D-082's, `goodwill`, `duplicate`, `dispute`).
- **The reads**: `TicketCard.refund` is null while active and for a seat cancelled with nothing given
  back; from the cancellation on, the seat's share, `original_payment_method`, `refundDelayCodeOf`'s
  delay and its refund's reason; a credited seat its credit's share, `account_credit`, no delay and
  no reason. `Order.refundReasonCode` on `refunded` and `partially_refunded`, the latest refund
  made's. `getOrder`, `purchaseSeat` and the two routes serve them through `ticketViewsOf`.
- **`cancelSeat`** (`POST /v1/seats/:seatId/cancel`, `SeatsController`, `no-store`): the token's
  account (401 without), `Idempotency-Key` scoped by it, the body optional and strict. A seat
  unknown, another account's or with none: 404. Then core's `assertSeatCancellable`:
  `seat.not_active`, then `seat.cancel_deadline_passed` with `cancelDeadline` (none: cancellable).
  The refund is the seat's entry of `seatSharesOf(total, quantity)`, seats in id order, capped at
  `refundableLeft`, owed under `refundIdempotencyKey` with the request's trace; on a `disputed`
  order, or once nothing is left, the seat is cancelled with nothing refunded (the provider holds
  the money, adr-payments.md §9; the lead's ruling). The seat returns to sale at once (D-093) by
  `releaseSoldSeats`: `seats_available + 1`, `seats_sold - 1`, one move, so a sold-out date is
  published back at once. **On a date a cancellation closed** the refund is `date_cancelled` (core's
  `refundReasonOnDate`, D-097), the deadline is not applied and no seat returns to sale. A
  cancellation committed after the date was read is caught by `releaseSoldSeats`, which refuses a
  cancelled date: the handler reads the outcome again and runs the whole transaction once more, so
  the refund says `date_cancelled` and no seat goes back on sale (the PT2 review's m3, PT4). It answers
  `{ ticket }`, the `TicketCard` but its `date`, which the BFF adds (T7).
- **`refundSeat`** (`POST /v1/seats/:seatId/refund`, `SeatRefundsController`, `no-store`): the
  studio's, `Idempotency-Key` in the operator's scope, `If-Rights-Version` parsed (an integer, else
  400 naming it), its check and the 403 auth slice B's, refused in production with the other studio
  routes. 404; 409 `seat.not_active`; a `disputed` order 409 `state.conflict` with the order's
  version and its state; `date_cancelled` on a date no cancellation closed 409 `state.conflict`
  with the date's version and its outcome when it has one (D-097, the lead's ruling); past
  `refundableLeft`, or nothing left, 409 `refund.amount_exceeds_remaining` with `remainingMinor`.
  The amount is `partialAmountMinor` in the order's currency, else the seat's share capped as
  above. Only `date_cancelled` cancels the seat (`refundCancelsSeat`, D-095), with no counter move;
  `goodwill`, `duplicate` and `dispute` leave it active whatever the amount. It answers `{ refunded,
  payoutId: null }`, with no `commissionRefunded` until payouts compute it (the commission is taken
  on the net of tax, which awaits counsel).
- **Lock order** (§0h): the seat read without a lock to find its order, the order locked
  (`findById`), then its seats and refund rows, the date's outcome read unlocked (`findUnlocked`),
  the date's row last: `releaseSoldSeats` is handed back as a `PendingCounterMove` and runs after
  the outbox rows and the kept answer, just before the commit (measured in `cancel-seat.itest.ts`: a
  hold's statement passes under its 200 ms bound while the cancellation's outbox insert sleeps a
  second). The key is claimed in the transaction that writes the refund and the seat. Neither route
  calls the provider or Redis: the worker's queue makes the refund (§0m).
- **A refund webhook** (`refund_succeeded`, its `refund_ref` and the cumulative `amount_refunded`
  kept on the inbox row) marks no refund made (R15, replaced by the lead after the PT2 review): a
  cumulative says how much was refunded, not which refunds, and two equal shares cannot be told
  apart. For each refund still owed (neither made nor given up on) that the amount no refund made
  explains could cover, it stamps `order_refund.rerun_asked_at` in its transaction. The relay's
  next pass, 50 requests at a time (each holds its row lock across Redis round trips), reads each
  job's state once, the lookups together, and promotes that refund's job when it waits its backoff
  (job id `jobIdOf(refund:{id})`),
  keeps the request while the job runs, and clears it otherwise: a job queued runs soon, and one
  lost is left to the stale sweep, never added again, since a call past the key's retention may be
  made twice. The provider answers under the refund's key, the existing refund or a new one, and
  the processor marks it made with its own reference and its `order.refunded`. It covers a call
  that timed out after the provider made the refund. A cumulative past every refund the order
  holds (a refund made outside the platform) is kept as applied, ignored and logged. Later (a core
  seam): the platform's refund id in the refund's metadata, carried back on the webhook, marks that
  refund made by id.
- **A dispute** (`dispute_opened`): the order `disputed`, above `refunded`, its seats left active,
  no provider call and no event (C1 adds none); one reaching an order not yet paid settles the
  payment first, as a confirmation would, so the seats a disputed charge implies exist. A refund
  still owed on it is given up at once (PT1, the PT2 review's m2): its job reads the order
  `disputed`, calls nothing, which the fake, as Stripe, would refuse, writes its dead row and logs
  that the dispute holds the buyer's money, not to be replayed (§0k). Given up rather than marked
  superseded: the row stays owed and visible, in case the merchant wins the dispute.
- **The fake** (§0g) plays both, signed as `completeAction`'s: `refundSucceededWebhookOf(refundRef)`,
  with what the charge refunded up to that refund, and `disputeOpened(intentRef)`.

