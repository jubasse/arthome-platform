## 0. Four processes, one database

All four read `DATABASE_URL` through `libs/config` (`NODE_ENV` required, never defaulted), close
their pool on SIGTERM, and are booted as their entry points boot them by `src/boot.itest.ts`. The
worker alone reads `REDIS_URL` (`readRedisUrl`, required in production): the API, the consumer and
the sweeper hold no Redis, so a Redis outage stops no purchase, no webhook and no expiry. The API
binds the internal token's guard, `DenyInProductionGuard` behind it, the envelopes and the validation
pipe through `@arthome-platform/http-edge`'s `edgeProviders` (`src/edge-providers.ts`), as catalog
does. Its readiness fails only on the database; the slot, the publication and the outbox
retention answer `degraded`.

**From T3 the API needs two more variables in production**, where neither has a default and the
API refuses to boot without them: `PAYMENT_WEBHOOK_SECRET` (32 characters at least, §0g) and
`PUBLIC_WEB_ORIGIN` (the payment return URL, §0h). Every route using them is refused in production
today, but the boot reads them. And neither the API nor the worker boots in production while the
fake payment adapter is the only one (§2, the architecture review's P1): both import the payment
ports.

**Deployment order: ticketing's consumer runs before the first date is drafted in production**
(both reviews, 2026-09-27). A sale opens only from `catalog.date.drafted`, and the consumer group
reads `arthome.catalog.date` from the beginning of what the topic keeps (168 h). A date drafted
longer than that before the group first reads it never opens: every later fact about it is
retried, then dead-lettered, and its checklist can never be satisfied. Nothing restates old drafts;
a catalog migration restating `DateDrafted`, and the start and lock of published dates, the way
`PublicSlugs1790420900000` restated `DateScheduled`, is the way back if it happens. On the
development stack the backlog was within the retention and opened every date drafted before.

