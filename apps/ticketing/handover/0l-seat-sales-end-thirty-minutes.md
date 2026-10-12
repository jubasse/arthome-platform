## 0l. Seat sales end thirty minutes after the start, and a late buyer is told (T3, D-089)

A sale ends by time, so no date is sold after its show and none stays in the publisher's pass for
good (§0e). The product owner ruled (D-089, recorded in core by the lead): **a seat covers the live alone** (a replay's access is a separate matter, out of T3), **its
sales end `SEAT_SALES_CUTOFF_MINUTES_AFTER_START` (30) minutes after the live's start**, the same
for every channel, and **a buyer arriving after the start is told what was missed and must
acknowledge it**. The rules are core's `seatSalesEndAt(startsAt)`, `salesEndedBy` and
`lateEntryOf(startsAt, now)`.

- **The end** is `date_sales.sales_end_at` (`1790440800000-sales-end.ts`), written by
  `recordSchedule` from `seatSalesEndAt` whenever catalog states or moves the start, so a
  postponement moves it; `1790440900000-seat-sales-cutoff.ts` backfilled it for the dates already
  scheduled.
- **A postponement applied late reopens a sale closed by time** (review m1). Core refuses a
  postponement once the live has started (`assertOutcomeDeclarable`, catalog's `outcome.ts`), so one
  declared in time always precedes the old cutoff; but the consumer may apply it after, when Kafka,
  the connector or the retry topic lags, and the sweeper, Postgres alone, closes the sale meanwhile.
  `recordSchedule` then reopens it (`DateSalesReopened`, one move for the publisher) when no closing
  outcome was recorded and the new end is ahead: sales go on, as adr-ticketing.md §8 has them.
- **The hold's statement refuses past the end by itself**: its WHERE gained
  `(sales_end_at IS NULL OR sales_end_at > $now)`, the command's instant, in `takeSeats` and in
  the late payment's `takeAndSellSeats`. Chosen over accepting the sweeper's second: a second at an
  opening's rate is seats sold past the cutoff, and one predicate on a row already found by its key
  costs nothing. The purchase reads the same end off the unlocked aggregate first
  (`sellsSeatsAt`) and refuses before claiming its key. **Past the end both `purchaseSeat` and
  `quoteSeat` answer 409 `order.sales_closed`** (core's `OrderErrorCode.SALES_CLOSED`; architecture review M2), with
  `salesEndAt`: sold out is the waiting list's cue, and a sale that ended offers no waiting list.
  Whether it ended is one rule, `salesEndedBy`, which the aggregate, the quote and the statement's
  predicate share.
- **The sweeper closes it** (`CloseEndedSales`, a third `SweeperLoop`, every second): each sale on
  sale past its end, in a transaction of its own under the date's row (taken once, when nothing
  sells any more), `DateSales.endSales` closes it at its end as a closing outcome does: `on_sale`
  false, one move and `closing_due` for the publisher's last publication (0 seats, not sold out).
  `DateSalesEnded` reaches no wire of its own.
- **The late entry.** From the start, `quoteSeat` carries `lateEntry` (`startedAt`,
  `minutesElapsed` in whole minutes, `salesEndAt`), and its `validUntil` is no later than the start
  before it and the end after it, where what it says changes. `purchaseSeat` reads the header
  `X-Arthome-Late-Entry-Acknowledged: true` (anything else but its absence is 400 naming it): from
  the start and without it, the purchase is refused 409 `order.late_entry_unacknowledged`
  (core's `OrderErrorCode.LATE_ENTRY_UNACKNOWLEDGED`) with the same three facts in `params`, before its key is claimed or any seat
  taken; before the start it is ignored. The field and the header are the contract's.
- **A header, not the body** (architecture review m2, the lead's decision), as the admission token
  is: the idempotency fingerprint covers the body, so a flag there could never be added to a
  purchase placed before the start and retried after it. **Decided here: such a retry is asked
  too.** A purchase resumed under its key that goes on to the provider after the start (its first
  attempt interrupted, or the provider down) is refused unacknowledged like a new one, its order
  untouched, and resumes once the retry carries the header. A replay of an answer already kept
  answers it again, whatever the clock says since. Past the cutoff, a resumed purchase whose hold is
  gone is answered 409 `order.sales_closed` at once, before it is asked anything, as a new one is,
  and its order fails with that code, so every retry under the key answers the same; one whose hold
  is still active took its seats in time and goes on.

