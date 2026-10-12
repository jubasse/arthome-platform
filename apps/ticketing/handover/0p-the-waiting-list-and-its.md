## 0p. The waiting list and its priority window (T5, PT3)

`src/waitlist/`, the pool in `date-sales/` and `orders/`; `1791636734134-waitlist.ts` (processes
stopped). adr-ticketing.md §9, D-083, D-093, D-094, D-096; core's `ticketing/waitlist.ts`.

- **An entry** (`WaitlistEntry`, `waitlist_entry`): one per account and date (UNIQUE `(date_id,
  account_id)`), no rank, registered again on the same row. States are C1's: `waiting`,
  `notified`, `converted`, `left`, `lapsed`, `closed`; every move is core's `waitlistEntryMayMove`,
  the set-based statements' included (checked before each builds its SQL). `closed` never moves;
  `lapsed` registers again.
- **The routes**, ticketing's own until its internal contract exists (D-121), for the account the
  internal token names (401 without one): `PUT /v1/dates/:dateId/waitlist` (join) and `DELETE` (leave),
  each with an `Idempotency-Key` through `runIdempotently`, scoped by the account;
  `GET` (`x-arthome-deadline` required, `no-store`). The join answers C1's `WaitlistRegistration`
  but its `date`, which the BFF adds (T7): `rankDisclosed: false`, `rank: null`,
  `priorityWindowHours`, `state` (null with no row), `joined` for `waiting` or `notified` only, and
  `priorityUntil` with `priorityPoolSeats` only while the caller is notified into an open window.
  An account already on the list is answered with nothing written; otherwise core's
  `assertWaitlistJoinable`: 409 `order.sales_closed` past the end or on a cancelled or interrupted
  date, 409 `waitlist.not_sold_out` while public seats remain. A date unknown, a sale never opened,
  and **a date with no start** (core: it sells nothing and has no list) answer 404. A leave answers
  `{ joined: false }` whatever it found; 404 only for a date ticketing does not hold.
- **Under the date's row.** Join and leave lock the date's row (`findById`), then the entry, then
  move `waitlist_count` by one conditional statement registered `writtenUnversioned`, counting a
  move for the publisher: the version does not move, so a flood of joins never makes the studio's
  `expectedVersion` stale. Two first joins under two keys: the second waits on the row, then finds
  the first's entry. The row is the only lock ordering a join against a tier opening and a window's
  end: a join commits before the marking or sees the window after it.
- **The tier opening** (`openCapacityTier`, one transaction): with `notifyWaitlist` and
  `waitlist_count > 0`, read under the row's lock, the tier goes to `priority_pool_seats`, not to
  `seats_available`, `priority_until` is core's `priorityUntilOf(now)` (an open window extended to
  it), every entry on the list is `notified` by one statement, and `waitlist.notified` rows name the
  accounts by account id, `WAITLIST_NOTIFIED_ACCOUNTS_MAX` (500) a row. **An entry already notified
  keeps its `notified_at`** (decided here): conversion is measured from it, so a purchase made in the
  first window still converts it once a second tier extended the window. With `notifyWaitlist: false`
  or nobody on the list (the lead's ruling beside D-094), the seats go on public sale and an open
  window keeps its pool and end.
- **The public figures exclude the pool**: `gaugeOf` passes `priority_pool_seats` to core and counts
  held as capacity minus sold, public and pool, so `seatsAvailable` is `seats_available`, which
  `refreshDateAvailability`, `availability_changed`, the join's sold-out test and `takeSeats` read
  alone. The pane serves `priorityPool` (`seatsLeft`, `priorityUntil`) while a window is open.
  CHECKs: the pool not negative, public + pool + sold within the capacity, a pool only with a
  window (`date_sales_pool_within_window`), `seat_hold.pool_seats` between 0 and `quantity`.
- **The purchase from the pool.** In tx A and in a resume's renewal, a buyer whose entry is
  `notified`, read unlocked and only while the unlocked date says a window is open
  (`drawsOnPriorityPool`), takes `takeSeatsFromPool`: one statement drawing on the pool first, then
  on the public seats, the pool only while `priority_until > $now` at the command's instant (a
  window the sweeper has not ended yet sells nothing from the pool past its end), and writing the
  pool share on the hold's own row in the same statement (a data-modifying CTE, `RETURNING
  old.priority_pool_seats - new.priority_pool_seats`), so the counter's statement stays the last of
  tx A. Anyone else goes through `takeSeats`, unchanged. Neither enough: `order.sold_out`. The quote
  carries `priorityUntil` to a buyer notified into an open window, `validUntil` no later.
- **A pool hold's seats go back to the pool while its window is open, on public sale after**
  (`returnHeldSeats` with the hold's `pool_seats`, in the expiry pass, `failUnpaidOrder` and
  `releaseHoldOf`): back on public sale, an abandoned checkout would hand the public the seats the
  list was promised. D-082's retake of a gone hold draws as the purchase does for a buyer still in
  the window (`takeAndSellSeats(…, fromPool)`). Once paid a pool seat is any seat (D-093, D-108):
  `cancelSeat` returns it to public sale.
- **The window's end** (`EndPriorityWindows`, `PriorityWindowSweeper`, a fifth `SweeperLoop`, every
  second, Postgres alone): the windows due through `idx_date_sales_priority_until`, each date in a
  transaction of its own `FOR UPDATE SKIP LOCKED` and left alone when a tier extended it since the
  read. Each `notified` entry becomes `converted` when its account holds an order on the date paid
  at or after its `notified_at`, else `lapsed`; `waitlist_count` drops by them; the pool's rest goes
  on public sale and `priority_until` is cleared, in one statement counting one move, so coming back
  from sold out publishes at once. No event, and the version does not move. **`converted` is decided
  here, not at payment** (PRD §13): the payment path takes no entry lock, so its lock order stays
  §0h's; an entry that bought stays `notified` until then. The paid order is found per entry through
  `seat_order_idempotency`'s leading `account_id`, a lateral `LIMIT 1` (`CONVERT_NOTIFIED_ENTRIES`).
  On a date a cancellation or an interruption ended before its settlement ran, the entries are
  `closed`, not `lapsed`, as D-096 makes them. A tier opened on a window past its end the sweeper
  has not reached yet ends it first, in its transaction under the date's row
  (`endDuePriorityWindow`): extended, it would carry the old pool and its lapsed entries, their
  first `notified_at` kept, into the new window.
  Measured (`window-end-plan.itest.ts`, three runs): 10,000 entries ended over 20,000 orders in
  133 to 173 ms, the date's row held for that long; no `seat_order` read sequentially.
- **D-096** (`WaitlistEndingHook`, bound in `DateOutcomesModule` in place of PT1's no-op, which
  PT1's interrupted-date suite still binds): in the settlement pass's own transaction, the date's row,
  then `notified` entries `converted` by the rule above or `closed`, `waiting` ones `closed`, the pool
  on sale (the sale is closed), `priority_until` cleared and `waitlist_count` 0. A rerun moves
  nothing; a window ended by the sweeper first, its entries already `closed`, leaves only the
  waiting ones. No event: nobody is
  told beyond the date's card. A postponement ends nothing.
- **`waitlist.notified`** (`ticketing.waitlist.notified.v1` on `arthome.ticketing.date_sales`, key
  `date_id`, in `TICKETING_EVENT_TOPICS`): one row per 500 accounts at a tier opening, one per join
  into an open window. Notifications reading it are a later slice.
- **Left as they are**: the entries of a sale ended by time (D-089). No rule ends them and nothing
  reads them; a retention purge can take them later.

