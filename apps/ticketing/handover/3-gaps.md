## 3. Gaps

**T3's interims are core's now** (arthome-core PR #7, a54847c): the payment ports, the order, seat
and hold vocabularies, the order-state ranks, the seat's cancel deadline, the order reference, the
payment return path, D-089's `SEAT_SALES_CUTOFF_MINUTES_AFTER_START`, `seatSalesEndAt`,
`salesEndedBy`, `lateEntryOf` and `LateEntry`, the codes `order.late_entry_unacknowledged` and
`order.sales_closed`, `HOLD_EXPIRY_BATCH` and `PAYMENT_WEBHOOK_TOLERANCE_SECONDS`. Core's
`decideWatch` no longer offers `buy_seat` past the cutoff. What stays local, and why:

- The injection tokens `PAYMENT_PORT` and `PAYMENT_WEBHOOK_PORT` (`payments/payment-tokens.ts`):
  core's ports are interfaces, which Nest cannot inject.
- `NextActionKind` (`payments/next-action.ts`): core keeps a next action's `kind` opaque, and only
  the fake provider and the suites name two.
- `ORDER_STATES_AWAITING_PAYMENT` (`orders/awaiting-payment.ts`): which states a payment's failure
  or expiry moves is this service's decision, not a vocabulary.
- Two seams core leaves to the caller: the year of an order reference, read off the placement
  instant, the sequence being this database's (`seat-order.typeorm-repository.ts`), and the
  `PUBLIC_WEB_ORIGIN` before core's `paymentReturnPath`, the origin being deployment configuration.
- No service fee (`date-sales/seat-quote.ts`): no fee schedule is set anywhere, as T2's pane says.

**Known and left in T3, each judged:**

- **The account is the internal token's** (auth slice A, 2026-10-03), and the commerce routes stay
  refused in production until a real payment adapter: `quoteSeat`, `purchaseSeat` and `getOrder`
  need a token naming an account (401 otherwise, no guest purchase); a purchase binds
  its hold, order and seats to it, its idempotency key is scoped by it, and `order.paid` and
  `seat.activated` carry it. The profile is the token's too (`PurchaseSeat.buyer`): a body naming
  another one is a 403, and until profiles land no token names any. `getOrder` serves the buyer alone: someone else's order is a 404, as one
  that does not exist. An order placed before slice A has no account and is served to nobody. The
  studio's routes (prices, capacity, provision, the pane) stay refused in production until slice B
  authorises them on the loaded date.
- **No tax computed.** `order.paid` carries an empty `vat` and the buyer's declared location alone,
  as unresolved evidence: the tax model awaits counsel (`adr-payments.md` §5.5).
- **A free seat** (a total of zero) would ask the provider for an intent of zero: no rule gives a
  contribution or a free tier yet, so none is refused or special-cased.


The three interims of the first handover are core's rules now (arthome-core PR #2, fbab36e):
`AVAILABILITY_VALID_SECONDS` and `availabilityValidUntil`, `provisionRevisableUntil` and
`assertTechnicalProvisionCovers`, `assertPricesShareCurrency`.

The technical provision is recorded by `setTechnicalProvision` (D-088, arthome-core PR #3,
7b271c7). The penalty exposure for a forecast far above the real figure has no rule in core yet
(D-088), so the pane serves none.

Known and left, each judged:

- `market_id` and the service-fee schedule have no source yet; neither is stored.
- **Catalog's service glue is shared since M4** (architecture review): `frozen` is
  `@arthome-platform/transactions`', `notFound`, `refusalOf` and `edgeProviders` are
  `@arthome-platform/http-edge`'s, `httpApp` is `@arthome-platform/testing`'s, and
  `writeTicketingEvent` (`outboxWriter` over ticketing's topics) and the consumer host
  (`ConsumerHostModule`, its `/nest` entry) are `@arthome-platform/messaging`'s. `assert-never.ts` is still one copy
  per service: its home is core, which this repository does not edit.
- **`CLOCK` is provided in each feature module and in `EDGE_PROVIDERS`** (N2): catalog's pattern,
  harmless while `SystemClock` is stateless. `edgeProviders` takes the service's token rather than
  owning one; one provider per process root needs `CLOCK` exported from a module every feature
  imports, a change to the DI graph the lift left out.
- **`pricesLockedAt` is catalog's engagement instant**, not ticketing's consumption (correctness
  nit 2): the studio shows one lock instant, and the contract's examples give catalog's publication
  `pricesLockedAt` and ticketing's `lockedAt` the same value. A price change applied between the two
  instants is what the lock then holds.
- **Two services' clocks order one date's facts** (correctness nit 3): the API's for
  `pricing_changed` and `capacity_set`, the sweeper's for `availability_changed`, compared by
  latest-wins consumers. It takes a skew larger than the seconds between two facts, NTP makes that
  unlikely, and catalog does the same: a platform pattern, not T2's alone.
- Proven on the development stack on 2026-09-27 at 630dbd5, at e0967b4, and at 70307cb after the
  re-review's three fixes and their migration `1790440400000`: the interval, the 10 s retry of an
  unpublishable date, and a closing published through `closing_due` (docs/agents/ticketing-date-sales-path.md).
- T3 proven on the development stack on 2026-09-29 at 040190f (docs/agents/ticketing-purchase-path.md): a purchase paid at once and replayed byte for byte, sold out past the seats, `order.paid`
  routed to `arthome.ticketing.order` on the order's key, the seats' events and the next
  availability on the date's, and a forged, a genuine and a duplicate webhook. A 202, the expiry and
  a late payment were not played there: the running fake confirms every intent, and the suites play
  them (§1).
