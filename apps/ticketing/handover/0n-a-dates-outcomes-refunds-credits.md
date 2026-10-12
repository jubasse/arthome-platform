## 0n. A date's outcomes: refunds, credits, the postponement (T4, PT1)

`src/date-outcomes/`, `src/credits/`; `1790441400000-date-outcomes.ts` (processes stopped).

- **The outcome fact** (§0d): once `recordOutcome` applied `cancelled` or `interrupted`, the
  consumer inserts the date's `date_outcome_settlement` row (`outcome`, `recorded_at` at ticketing's
  clock, the message's `traceparent`) `ON CONFLICT DO NOTHING`, in the transaction that claims the
  message: an outcome is final (D-076), and the row is written once. A postponement writes none.
  The migration backfilled a row for each date already cancelled or interrupted.
- **The settlement pass** (`SettleDateOutcomes`, run by `DateOutcomeSweeper`, a fourth `SweeperLoop`
  in the sweeper, every second, Postgres alone): the oldest unsettled rows, ten dates a pass, and a
  date that failed only once its `DATE_OUTCOME_RETRY_SECONDS` (10) are past, behind the others, as
  the publisher sets a date aside (§0e). A date waiting on a live hold alone (its orders settled,
  its waiting list ended) sorts behind every date with work left, so ten of them cannot fill every
  pass while another date's refunds wait (the PT1 review's F1, PT4). Each step claims the date's row `FOR UPDATE SKIP LOCKED`
  in a transaction of its own, so replicas share the dates.
  - **500 orders per transaction** (adr-ticketing.md §8): the date's orders holding an `active` seat
    and not marked `outcome_settled_at`, found through `idx_seat_date_active` then by key (as a
    semi-join the planner hashed them against every order ever placed), by id, `FOR UPDATE SKIP
    LOCKED`: one a payment or `cancelSeat` holds is taken by a later pass. Each is marked in the
    batch whatever it gave.
  - **A cancellation** (`cancelledDateSettlementOf`): what is left of the order's money
    (`refundableLeft`) owed in one refund, `date_cancelled`, under `refundIdempotencyKey`, no seat,
    with the settlement's trace; then its active seats `cancelled` (`cancelSeats`, §0o,
    `DATE_CANCELLED`) with their `seatSharesOf` shares in seat-id order, one `seat.cancelled` each on
    the date's key. They are `refunded` when the worker's queue makes the refund (§0m), which writes
    one `order.refunded` `DATE_CANCELLED`: one refund per order, so one job. An order holding no
    money any more, refunded in full before or `disputed` (the provider holds it, adr-payments.md
    §9), has its seats cancelled with nothing given back.
  - **An interruption** (`interruptedDateSettlementOf`): one credit note per order for
    `creditAmountFor(refundableLeft)`, on the order's account and channel (D-017),
    `interrupted_date`, `origin_ref` the date, `issued`, expiring `CREDIT_VALIDITY_MONTHS` later
    (`creditExpiresAt`), with `credit.issued` on `arthome.ticketing.account` keyed by the account,
    for payouts and notifications; then its active seats `credited` with their shares
    (`creditSeats`), no `seat.cancelled` (D-092). Nothing left, or disputed: no credit, the seats
    left as they are. An order with no account (placed before auth slice A, none in production) is
    left so and logged: a credit is an account's. `credit` is unique on `(order_id, origin)`,
    inserted `ON CONFLICT DO NOTHING`: an order credited already gets nothing more and no event. A
    credit of fewer minor units than seats gives a seat a share of nothing, which seat-states' CHECK
    lets `credit_amount_minor` hold (§0o): refused, it aborted the batch of 500.
  - **The waiting list, once** (D-096): after the batch, while `waitlist_ended_at` is null, one
    transaction claims the row, calls `WaitlistOutcomeHook.endWaitlist(transaction, dateId, now)`
    and stamps it. `NoWaitlistOutcomeHook`, a no-op, is bound in `DateOutcomesModule` until PT3
    replaces that binding. Money first: a hook that fails holds no refund back, the batches going on
    at each retry, and the date is not settled until it passed.
  - **Settled** when a batch short of 500 finds, the waiting list ended, no order of the date
    holding an active seat unmarked and no active hold on it: one statement, so one snapshot, since
    a payment through a hold active at the outcome commits its consumed hold and its seats together
    and is seen as one or the other, never neither. `settled_at` is stamped and `failed_at` cleared.
    A hold active at the outcome can still be paid, so the date stays in the pass until its last
    hold ends, a checkout's intent expiry after the outcome at most.
  - **Failures**: a step that throws rolls back, is logged with the date as a warning, stamps
    `failed_at`, and the date is tried again 10 s later, behind the others; one still failing an
    hour after its outcome was recorded logs an error naming it.
  - **Counters**: a sale a cancellation or an interruption closed has no seat to sell, so the pass
    moves none of `date_sales`' counters and never locks that row. It calls no provider and holds
    no Redis: a refund is a row the worker's queue makes.
  - Measured (`cancelled-date.itest.ts`): 1,200 orders and 1,800 seats settled in about 20 s on a
    quiet machine, about 6 s a batch of 500 (each order loaded and saved on its own), three times
    that beside the other suites; their refunds drained by the queue in about 60 s, at its 20 a
    second (§0m). At those rates a date of 10,000 orders takes about three minutes of passes and
    eight of refunds.
- **Late payments** (D-097, `orders/settle-payment.ts`): the date is read, unlocked, before the
  branch. On a sale a cancellation closed a payment gets no seat: an active hold is released, its
  seats given back by `returnHeldSeats` (the counter move kept for last), and the whole payment is
  owed back through `oweUnseatedPaymentBack` as `refundReasonOnDate(outcome,
  hold_expired_capacity_lost)`, `date_cancelled`; so is one whose hold is gone. A cancellation
  committed between that read and D-082's retake, which then refuses (`on_sale` false), is read
  again, so that refund says `date_cancelled` too. A payment that read the date before the
  cancellation committed seats its order after it: its hold stayed active until then, so the date
  stayed in the pass, which refunds it. On an interrupted date a payment seats as before and the
  pass credits it ("one credit per paid order"; D-097 speaks of cancellations alone).
  `uq_order_refund_unseated` now holds one unseated refund per order, `hold_expired_capacity_lost`
  or `date_cancelled`, which covers the date's own refund as well.
- **The postponement** (adr-ticketing.md §8): a `start` fact that applies moves the date's active
  seats' `cancel_deadline` to `seatCancelDeadline(startsAt)` in the fact's transaction, one
  statement through `idx_seat_date_active` run before the date's row is locked, so no hold waits
  behind it (measured: a hold's statement passes under its 200 ms bound while the seats' statement
  sleeps a second). The statement moves none against a newer start already committed; one
  committed between the statement and the lock finds the fact stale under it, and the handler
  throws, rolling the seats back with the claim, so its redelivery moves none and is answered
  `superseded`. No event for the moved deadline (C1 decides none): consumers compute
  `seatCancelDeadline(new_starts_at)` from `catalog.date.rescheduled.v1`. The hook is not called and
  the entries stay waiting (D-096).
  - **A window left**: a payment that read the start before a postponement committed inserts its
    seats with the old deadline, and nothing moves them if it commits after the postponement's
    statement. It takes a payment and a postponement of one date within the same milliseconds; PT4's
    race suite is where to prove or close it.
- **Lock order**, the lane's, PT3's included: the settlement row first, then `seat_order` by id (its
  own `seat`, `order_refund` and `credit` rows right after it), `seat_hold`, `date_sales`,
  `waitlist_entry`. A batch takes the settlement row, then its orders, then their seats, refund
  rows and credits (a credit after its order, before the seats that name it), never the date's row;
  the hook's transaction takes the settlement row, then what PT3's hook takes in that order (the
  date's row and its pool, then the entries); the postponement takes the seats, then the date's row;
  the consumer only inserts the settlement row, which nobody holds yet. A payment takes its order,
  its hold, then the date's row last (§0h): one on a cancelled date waits for a batch holding its
  order, then is given no seat. PT3's paths (§0p): a join, a leave and a tier opening take their
  `idempotency_record`, then the date's row, then the entries (a tier opening ending a window past
  its end takes the date's row by that claim, waiting); the window's end takes the date's
  row (`SKIP LOCKED`), then the entries, reading `seat_order` unlocked; a purchase from the pool
  reads its entry unlocked and locks no entry. A replay's grant or revocation (§0r) takes the date's
  `replay_window` row, then its `replay_access` rows, reading `seat` and `date_sales` unlocked: it
  locks none of the rows above.
- **Exactly once**: `claimMessage` in the fact's transaction; `outcome_settled_at` stamped in the
  batch's transaction and read by its selection; `credit` unique on `(order_id, origin)`; and the
  date's refund one of the order's unseated refunds, which `uq_order_refund_unseated` holds to one.

