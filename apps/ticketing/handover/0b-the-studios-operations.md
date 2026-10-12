## 0b. The studio's operations

`PUT /v1/dates/:dateId/prices`, `POST /v1/dates/:dateId/capacity-tiers`,
`PUT /v1/dates/:dateId/technical-provision` and `GET /v1/dates/:dateId/panes/tickets`, in
`openapi/studio.yaml`'s shapes.

- The three commands take an `Idempotency-Key` (`runIdempotentlyVersioned`: the version at the
  envelope's root), answer the pane read off the row inside their transaction, and refuse 409 with
  the domain's code: `state.conflict` with `version`, `date.prices_locked`,
  `date.prices_currency_mismatch`, `capacity.tier_must_widen`, `date.technical_provision_required`,
  `date.provision_deadline_passed`, `date.provision_below_capacity`.
- `setDatePrices` refuses 400 naming `tiers` a tier sent twice: a malformed body. Two currencies
  are a well-formed body a rule refuses, 409 above.
- `openCapacityTier` notifies the waiting list when `notifyWaitlist` is true and someone is on it:
  the tier becomes the priority pool and it answers `waitlistNotified` and `priorityUntil` (§0p);
  otherwise the seats go on public sale, `waitlistNotified: 0`, no `priorityUntil`. On a sale a
  cancellation or an interruption closed, it refuses 409 `state.conflict` naming the version and
  the outcome.
- **The pane** is `DateSalesPaneSchema`'s, parsed in the suites. Absent: `serviceFeePerSeat` and
  `replayUnitPrice` (no schedule is set anywhere), `complimentaries`, the penalty exposure (no rule
  in core), `grossRevenue` (it needs `canRevenue` and a sale). `promotions` is empty.
- A date ticketing has not opened yet is 404: the studio can reach the pane a moment before the
  consumer reads `catalog.date.drafted`.

