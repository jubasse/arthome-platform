## 0c. The storefront's `refreshDateAvailability`

`GET /v1/dates/:dateId/availability`: seats available, waiting list, fill rate, sold out, the price
tiers, read live off the row, each through core (`date-sales-figures.ts`, which the pane and the
event share). It requires `x-arthome-deadline`, answers `no-store` (the BFF sets `public,
max-age=15`, the operation's freshness, transport.md §5.9), and carries core's
`availabilityValidUntil`, `AVAILABILITY_VALID_SECONDS` after `servedAt`. **Only a sale on
sale is served** (`on_sale`): before it opens, and once a cancellation or an interruption closed it,
the read answers 404 rather than seats nobody can buy.

