/**
 * The outbox table, defined once for the seven services. The column names belong to the
 * Debezium outbox router, not to us, and the constraints are what keep a service from killing
 * its own connector — seven copies of that would be a parallel literal table in the one place
 * where drift is silent until it is catastrophic.
 */

/** A Kafka topic segment: what `aggregatetype` is interpolated into. */
const TOPIC_SEGMENT = String.raw`^[a-zA-Z0-9._-]+$`;

/** `<context>.<aggregate>.<event>.v<N>` — events.md §1.3. */
const VERSIONED_TYPE = String.raw`^[a-zA-Z0-9._-]+\.v[0-9]+$`;

/**
 * ⚠ The CHECK constraints are the point, and they were written after measuring what happens
 *   without them: one row whose `aggregatetype` contained a space produced
 *   `InvalidTopicException`, and Kafka Connect's answer was "Task is being killed and will not
 *   recover until manually restarted." That is the worst failure on this path — it is not
 *   per-record, so every later event from that service stops; the replication slot then
 *   retains the write-ahead log until the disk fills; and restarting reads the same row and
 *   dies again, so THE ONLY RECOVERY IS DELETING AN ALREADY-COMMITTED BUSINESS FACT. No
 *   Connect setting reaches it — the failure is raised in the producer's send callback, past
 *   `errors.tolerance` and past a dead-letter queue a source connector does not have. So it
 *   is made impossible upstream, inside the transaction, where a human can still be refused.
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
    // Interpolated straight into a topic name: a space, a slash or an accent is an
    // InvalidTopicException that kills the task for good.
    `CONSTRAINT ${table}_aggregatetype_is_topic_safe
       CHECK (aggregatetype ~ '${TOPIC_SEGMENT}' AND length(aggregatetype) <= 200)`,

    // The partition key. Empty hashes every aggregate onto one partition — ordering silently
    // stops meaning anything, and nothing fails.
    `CONSTRAINT ${table}_aggregateid_present
       CHECK (length(aggregateid) > 0)`,

    // Chooses the handler inside a multi-type topic; the version suffix is what lets a shape
    // change without breaking a reader.
    `CONSTRAINT ${table}_type_is_versioned
       CHECK (type ~ '${VERSIONED_TYPE}')`,

    // Zero bytes decode to a default-valued message rather than to an error, so an empty
    // payload is a fact that arrives saying nothing and claims success.
    `CONSTRAINT ${table}_payload_not_empty
       CHECK (octet_length(payload) > 0)`,
  ];
}
