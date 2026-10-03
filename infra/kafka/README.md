# Kafka topics

`topics.json` declares every topic with its partitions and retention.

## Production ACLs: the verification token's topics

The development broker runs PLAINTEXT with no authorizer and no ACL (`compose.yaml`): anything on
the network reads and writes every topic. Production must not.

`arthome.identity.email_verification` carries D-100's verification token in clear (`events.md` §3).
A reader of the topic can verify any address it sees. A writer can make `notifications` mail an
Arthome-branded link of its choosing to any address. A failed message is copied, token included, to
`notifications`' retry and dead-letter topics. So a production broker runs with an authorizer, and
these ACLs are a deployment requirement:

| Topic | Read | Write |
|---|---|---|
| `arthome.identity.email_verification` | `notifications`' principal, groups `notifications` and `notifications-retry`; the outbox reconciler's principal (`republish:outbox`), groups prefixed `outbox-reconcile-` | identity's Kafka Connect principal, nothing else |
| `arthome.notifications.retry` | `notifications`' principal, group `notifications-retry` | `notifications`' principal |
| `arthome.notifications.dlq` | the operator's principal that inspects or replays it; `ops:check` needs Describe only | `notifications`' principal |

- **Retry and dead-letter topics are written by `notifications` itself**, since it copies a failed
  message there, so they cannot share the source topic's "identity's Connect only".
- **The reconciler reads only the `message-id` header**, but Kafka has no ACL finer than the topic,
  so its principal can read the tokens. Restrict who may run it.
- **A new consumer of the verification topic is a review question**, not a code change alone:
  `apps/identity/src/auth/verification-topic.spec.ts` fails when an app other than `notifications`
  names the topic.
- **The account topic, `arthome.identity.account`, carries no token.** Other contexts may read it.
