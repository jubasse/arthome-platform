/**
 * The outbox table, defined once for the seven services.
 *
 * ⚠ WHY THIS IS A SHARED CONSTANT AND NOT SEVEN HAND-WRITTEN MIGRATIONS. The
 *   column names belong to the Debezium outbox router, not to us — lowercase and
 *   unseparated — and the constraints below are what keep a service from killing
 *   its own connector. Seven copies of that would be a parallel literal table
 *   under a common name, in the one place where drift is silent until it is
 *   catastrophic.
 */

/** A Kafka topic segment: what `aggregatetype` is interpolated into. */
const TOPIC_SEGMENT = String.raw`^[a-zA-Z0-9._-]+$`;

/** `<context>.<aggregate>.<event>.v<N>` — events.md §1.3. */
const VERSIONED_TYPE = String.raw`^[a-zA-Z0-9._-]+\.v[0-9]+$`;

/**
 * The DDL for one service's outbox.
 *
 * ⚠ THE CHECK CONSTRAINTS ARE THE POINT, AND THEY WERE WRITTEN AFTER MEASURING
 *   WHAT HAPPENS WITHOUT THEM. One row whose `aggregatetype` contained a space
 *   produced `InvalidTopicException`, and Kafka Connect's answer was: "Task is
 *   being killed and will not recover until manually restarted."
 *
 *   Three things make that the worst failure this path has:
 *     · it is not per-record. The task dies, so EVERY later event from that
 *       service stops — the outbox is the service's only way out.
 *     · the replication slot then retains the write-ahead log indefinitely,
 *       which ends as a full disk rather than as an alert.
 *     · restarting the task does not help. It reads the same row and dies again.
 *       THE ONLY RECOVERY IS DELETING THE ROW — destroying a business fact that
 *       is already committed.
 *
 *   And no Connect setting reaches it: the failure is raised in the producer's
 *   send callback, past `errors.tolerance` and past the dead-letter queue, which
 *   a source connector does not have in the first place. So there is nothing to
 *   catch downstream, and the fault has to be made impossible upstream — inside
 *   the transaction that would have written it, where a human is still waiting
 *   on a request that can be refused.
 */
export function outboxTableDdl(table = 'outbox_event'): string {
  return `
    CREATE TABLE ${table} (
      id            uuid        PRIMARY KEY,
      aggregatetype text        NOT NULL,
      aggregateid   text        NOT NULL,
      type          text        NOT NULL,
      payload       bytea       NOT NULL,
      tracecontext  text        NULL,
      actor_id      text        NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),

      ${outboxConstraints(table).join(',\n      ')}
    )
  `;
}

/** The constraints alone, so a table that already exists can be brought up to them. */
export function outboxConstraints(table = 'outbox_event'): string[] {
  return [
    // Interpolated straight into a topic name. A space, a slash or an accent
    // here is an InvalidTopicException that kills the task for good.
    `CONSTRAINT ${table}_aggregatetype_is_topic_safe
       CHECK (aggregatetype ~ '${TOPIC_SEGMENT}' AND length(aggregatetype) <= 200)`,

    // The partition key. Empty means every event of every aggregate lands on one
    // partition by hashing the same value — ordering silently stops meaning
    // anything, and nothing fails.
    `CONSTRAINT ${table}_aggregateid_present
       CHECK (length(aggregateid) > 0)`,

    // The handler is chosen by this inside a multi-type topic, and the version
    // suffix is what lets a shape change without breaking a reader.
    `CONSTRAINT ${table}_type_is_versioned
       CHECK (type ~ '${VERSIONED_TYPE}')`,

    // Zero bytes decode to a default-valued message rather than to an error, so
    // an empty payload is a fact that arrives saying nothing and claims success.
    `CONSTRAINT ${table}_payload_not_empty
       CHECK (octet_length(payload) > 0)`,
  ];
}
