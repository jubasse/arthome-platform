import { deadLetterTopic, retryTopic, routeFailure } from '@arthome-platform/messaging';
import type { EachMessagePayload, IHeaders, Producer } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { applyMessage, type Outcome } from './account-consumer.js';

/** Headers this service adds when it re-publishes a message it could not apply. */
export const ATTEMPT_HEADER = 'arthome-attempt';
export const NOT_BEFORE_HEADER = 'arthome-not-before';
export const ORIGIN_HEADER = 'arthome-origin-topic';
export const ERROR_HEADER = 'arthome-error';

export function attemptsSoFar(headers: IHeaders | undefined): number {
  const raw = headers?.[ATTEMPT_HEADER];
  if (raw === undefined || raw === null) return 0;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Everything the original message carried, kept so a replay is possible at all. */
function forwarded(payload: EachMessagePayload): IHeaders {
  const kept: IHeaders = {};
  for (const [name, value] of Object.entries(payload.message.headers ?? {})) {
    if (value !== undefined && value !== null) kept[name] = value;
  }
  return kept;
}

export type Disposition = Outcome | 'retried' | 'dead-lettered';

/**
 * Apply a message, and put it where it belongs when that fails.
 *
 * ⚠ THE FAILURE PATH PUBLISHES BEFORE IT RETURNS, and returning normally is what
 *   lets the offset advance. A consumer that rethrows here would make KafkaJS
 *   redeliver the same message immediately and for ever — a hot loop that looks
 *   like a working retry until you read the broker's traffic.
 *
 * ⚠ THE ORIGINAL TOPIC IS CARRIED. Without it, a message in the retry topic has
 *   no way back: the handler is chosen by `type`, but the operator looking at a
 *   dead letter needs to know where it came from.
 */
export async function dispatch(
  dataSource: DataSource,
  producer: Producer,
  service: string,
  payload: EachMessagePayload,
  now: Date = new Date(),
): Promise<Disposition> {
  try {
    return await applyMessage(dataSource, payload);
  } catch (error) {
    const attempts = attemptsSoFar(payload.message.headers);
    const route = routeFailure(error, attempts, now);
    const headers = forwarded(payload);
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
    headers['arthome-dlq-reason'] = route.reason;
    await producer.send({
      topic: deadLetterTopic(service),
      messages: [{ key: payload.message.key, value: payload.message.value, headers }],
    });
    return 'dead-lettered';
  }
}
