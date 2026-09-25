import type { EachMessagePayload, IHeaders, Producer } from 'kafkajs';

import { deadLetterTopic, retryTopic, routeFailure } from './failure.js';

/** Headers a service adds when it re-publishes a message it could not apply. */
export const ATTEMPT_HEADER = 'arthome-attempt';
export const NOT_BEFORE_HEADER = 'arthome-not-before';
export const ORIGIN_HEADER = 'arthome-origin-topic';
export const ERROR_HEADER = 'arthome-error';
export const DLQ_REASON_HEADER = 'arthome-dlq-reason';

/** `applied` wrote the effect, `duplicate` found it already written, `ignored` was not ours. */
export type Outcome = 'applied' | 'duplicate' | 'ignored';

export type Disposition = Outcome | 'retried' | 'dead-lettered';

/** Throws `PermanentError` for what a retry cannot fix; any other throw is treated as transient. */
export type MessageHandler = (payload: EachMessagePayload) => Promise<Outcome>;

export function header(payload: EachMessagePayload, name: string): string | null {
  const raw = payload.message.headers?.[name];
  if (raw === undefined || raw === null) return null;
  const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  // ⚠ Debezium renders a NULL column as the four characters `null`, not as an
  //   absent header. Storing that is how a trace id becomes the word "null".
  return value === 'null' ? null : value;
}

export function attemptsSoFar(headers: IHeaders | undefined): number {
  const raw = headers?.[ATTEMPT_HEADER];
  if (raw === undefined || raw === null) return 0;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function forwarded(payload: EachMessagePayload): IHeaders {
  const kept: IHeaders = {};
  for (const [name, value] of Object.entries(payload.message.headers ?? {})) {
    if (value !== undefined && value !== null) kept[name] = value;
  }
  return kept;
}

/**
 * Apply a message, and put it where it belongs when that fails.
 *
 * ⚠ THE FAILURE PATH PUBLISHES BEFORE IT RETURNS, and returning normally is what
 *   lets the offset advance. A consumer that rethrows here would make KafkaJS
 *   redeliver the same message immediately and for ever — a hot loop that reads
 *   like a working retry until you look at the broker's traffic.
 *
 * ⚠ IF THE REPUBLISH ITSELF FAILS, THE ERROR ESCAPES ON PURPOSE. No commit, so
 *   the message is redelivered rather than lost. That makes republish-then-commit
 *   a dual write, and a crash between them duplicates — which is exactly what
 *   the handler's deduplication absorbs.
 */
export async function dispatch(
  handler: MessageHandler,
  producer: Producer,
  service: string,
  payload: EachMessagePayload,
  now: Date = new Date(),
): Promise<Disposition> {
  try {
    return await handler(payload);
  } catch (error) {
    const attempts = attemptsSoFar(payload.message.headers);
    const route = routeFailure(error, attempts, now);
    const headers = forwarded(payload);

    // The origin is kept from the FIRST publication: a message on its second
    // retry must still say where it came from, not say "the retry topic".
    headers[ORIGIN_HEADER] = String(headers[ORIGIN_HEADER] ?? payload.topic);
    headers[ERROR_HEADER] =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);

    if (route.kind === 'retry') {
      headers[ATTEMPT_HEADER] = String(route.attempt);
      headers[NOT_BEFORE_HEADER] = route.notBefore.toISOString();
      await producer.send({
        topic: retryTopic(service),
        messages: [{ key: payload.message.key, value: payload.message.value, headers }],
      });
      return 'retried';
    }

    headers[ATTEMPT_HEADER] = String(attempts);
    headers[DLQ_REASON_HEADER] = route.reason;
    await producer.send({
      topic: deadLetterTopic(service),
      messages: [{ key: payload.message.key, value: payload.message.value, headers }],
    });
    return 'dead-lettered';
  }
}
