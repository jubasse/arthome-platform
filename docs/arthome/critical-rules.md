<!-- COPIED BY `arthome-sync-agent-docs` ON INSTALL. DO NOT EDIT.
     The original is `architecture/critical-rules.md` in arthome-core; edit it there.
     This copy is committed on purpose: a `postinstall` that rewrites it makes
     `git status` the freshness check, so no gate is needed to notice a stale one. -->

# Arthome critical rules — reread at every session

> Style, naming, tooling → `code-conventions.md`. What makes a unit of work finished → `definition-of-done.md`.

1. **No synchronous call between services**: the BFF calls a service, a service speaks only to Kafka. BullMQ stays inside one service.
2. **Any value displayed twice comes from `@arthome/core`**: two *calls* are allowed, two *implementations* never.
3. **Business write and outbox row in the same transaction**, through the same `manager` — never `save()` then `emit()`. A consumer deduplicates on `message-id` **inside that same transaction**.
4. **Token verified against JWKS locally**, with `algorithms`/`issuer`/`audience` pinned: no service calls `identity`, never an `x-user-id`. The JWKS is **a static document served by the CDN**, the only source of keys — **no private key ever enters it, and a key is published before it is retired**.
5. **Every service authorises for itself, on the loaded instance** — never "only the BFF calls me": a time-boxed grant expires inside a token's lifetime.
6. **Dates travel as ISO 8601 UTC strings.** *Exception: inside a JWT, `exp`/`iat`/`nbf` stay numeric seconds (RFC 7519) — this is not a mistake, do not "fix" it.*
7. **Amounts as integer minor units + ISO currency code.** Formatting belongs to the client and never travels.
8. **i18n by codes**: no interface sentence in a payload. An error carries `code`, `params`, `traceId` and `nature` (`refused` / `unavailable` / `offline_forbidden`).
9. **Every response carries `servedAt`**; every perishable value carries `validUntil`. A countdown is computed against `servedAt`, never against the client's clock.
10. **An unknown enum value is kept raw and treated as neutral**, never rejected: strictness applies to the shape, never to the member.
11. **A field forbidden by role is absent from the response**, never present and null; a sort on an absent field is **refused**, never ignored.
12. **A replayed idempotency key returns the original response**, never a duplicate error.
13. **`traceparent` propagated** from surface to service, **and injected into `outbox_event.tracecontext` at write time** — injected later, the link is lost.
14. **Additive migrations only on CDC-captured tables**: renaming a column breaks replication silently.
15. **An operational constant has one owning document** — cadence, duration, threshold, ceiling: elsewhere you **reference** it, never copy it. A plausible copied number is silently wrong and no test contradicts it. **And a uniqueness claim ages the same way** — "the only", "both", "no other": true the day it is written, false the next, never reread because it rings true. Count it or reference it, do not assert it.
