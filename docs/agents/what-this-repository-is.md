## What this repository is

The seven NestJS microservices and their infrastructure. Two services first — `identity` and
`catalog` — but the whole event path end to end: the outbox inside the transaction, a versioned
Protobuf schema, CDC into the index, `traceparent` carried through.

The architecture, the ADRs and the arbitration log live in
**[arthome-core](https://github.com/jubasse/arthome-core)**, not here.
