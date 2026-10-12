## 0a. `DateSales`

`src/date-sales/date-sales.aggregate.ts`, one row of `date_sales` (`1790440000000-initial.ts`).

- **Capacity** opens by tiers (`openCapacityTier`, the first one included) and widens through core's
  `assertTierWidens`; nothing shrinks it. Each tier is kept with its id, size and instant.
- **The counters** `seats_available`, `seats_sold`, `waitlist_count` and `priority_pool_seats`
  (§0p) are written by the repository **as deltas** from what it loaded (`seats_available + n`),
  never as values: T3's conditional decrement moves them without the version (ADR §11). A CHECK
  refuses a negative counter and public, pool and sold seats past the capacity; the decrement's
  WHERE stays the rule.
- **Prices** are replaced whole until the sale opens, then refused `date.prices_locked` with
  `lockedAt`. The sale opens when `catalog.publication.engaged` names the prices; `on_sale` is a
  column Postgres generates from the lock and the close, for T3's WHERE.
- **The technical provision** (D-088) is `technicalProvisionOf` (`technical-provision.ts`): core's
  threshold and `requiresTechnicalProvision`, the capacity the studio's recorded provision covers,
  and core's `provisionRevisableUntil` whenever catalog has stated a start. `setTechnicalProvision`
  records or revises it through core's `assertTechnicalProvisionRecordable`: refused 409
  `date.provision_deadline_passed` from the deadline on, `date.provision_below_capacity` below the
  capacity already open. `openCapacityTier` passes it to core's `assertTechnicalProvisionCovers`: a
  capacity past the threshold it does not cover is refused 409 `date.technical_provision_required`,
  naming the threshold, the capacity asked for, the provision and the deadline.
- **One currency per sale** is core's `assertPricesShareCurrency`, called by `setPrices`: 409
  `date.prices_currency_mismatch`, naming the stray tier, its currency and the expected one.
- **The version** counts every load-modify-save, a studio command's or a consumed fact's: a studio
  screen that did not see a reschedule or the lock is stale like any other (accepted by the lead,
  2026-09-27). A command names it (`expectedVersion`); a fact is guarded by its own `occurred_at` per
  group (the start, the outcome), and the lock happens once. Events are stated at ticketing's clock,
  catalog's instant kept only as the guard, so a skew between the two cannot reorder one stream.

