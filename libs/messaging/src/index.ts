export { PermanentError, RETRY_DELAYS_MS, JITTER_RATIO } from './failure.js';
export { deadLetterTopic, retryTopic, routeFailure } from './failure.js';
export type { FailureRoute } from './failure.js';

export { OutboxEvent } from './outbox-event.entity.js';
export { outboxConstraintNames, outboxConstraints, outboxTableDdl, outboxTopic } from './outbox.js';
export {
  OUTBOX_RETENTION_DAYS,
  PROCESSED_MESSAGE_RETENTION_DAYS,
  purgeOutbox,
  purgeProcessedMessages,
} from './retention.js';
export type { PurgeOutcome } from './retention.js';
export { writeOutboxEvent } from './write.js';
export type { OutboxFact } from './write.js';

export {
  ATTEMPT_HEADER,
  DLQ_REASON_HEADER,
  ERROR_HEADER,
  NOT_BEFORE_HEADER,
  ORIGIN_HEADER,
  attemptsSoFar,
  dispatch,
  header,
} from './dispatch.js';
export type { Disposition, MessageHandler, Outcome } from './dispatch.js';

export { runConsumers } from './consume.js';
export type { ConsumerSetup } from './consume.js';

export {
  boundedCheck,
  checkDatabaseReachable,
  checkDeadLetterDepth,
  checkUnpublishedOutbox,
  checkOutboxRetention,
  checkProcessedMessageRetention,
  checkPublicationScope,
  checkReplicationSlot,
} from './health.js';
export type { CheckResult, CheckStatus } from './health.js';

export { MAX_SLOT_LAG_BYTES, outboxSlotName } from './slot.js';
export {
  findUnpublishedOutboxRows,
  readPublishedMessageIds,
  REPUBLISH_HORIZON_HOURS,
  republishOutboxRow,
} from './republish.js';
export type { PublishedIdsReader, Reconciliation, UnpublishedRow } from './republish.js';
