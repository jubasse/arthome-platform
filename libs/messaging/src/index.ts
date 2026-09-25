export { PermanentError, RETRY_DELAYS_MS, JITTER_RATIO } from './failure.js';
export { deadLetterTopic, retryTopic, routeFailure } from './failure.js';
export type { FailureRoute } from './failure.js';

export { OutboxEvent } from './outbox-event.entity.js';
export { outboxConstraintNames, outboxConstraints, outboxTableDdl } from './outbox.js';
export { purgeOutbox, purgeProcessedMessages } from './retention.js';
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
