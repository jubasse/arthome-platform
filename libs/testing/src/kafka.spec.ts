import { KafkaJSConnectionError, KafkaJSProtocolError } from 'kafkajs';
import type { EachMessagePayload, Kafka } from 'kafkajs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTopics, headersOf } from './kafka.js';

/**
 * The only part of this package that can be asserted without a container, so it
 * is the only part named `.spec.ts` — `pnpm run verify` runs this file and must
 * never run the `.itest.ts` ones beside it.
 */
function payload(headers: Record<string, string>): EachMessagePayload {
  return {
    topic: 'arthome.harness.probe',
    partition: 0,
    message: {
      key: Buffer.from('key'),
      value: Buffer.from('value'),
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, Buffer.from(value)]),
      ),
    },
  } as unknown as EachMessagePayload;
}

describe('headersOf', () => {
  it('turns every header into a string', () => {
    const named = headersOf(payload({ 'message-id': 'abc', type: 'harness.probe.happened.v1' }));
    expect(named).toEqual({ 'message-id': 'abc', type: 'harness.probe.happened.v1' });
  });

  it('treats Debezium’s literal "null" as an ABSENT header, not as a value', () => {
    // Debezium renders a NULL column as the four characters `null` rather than
    // as a missing header. A helper that handed that through would let a test
    // assert on a traceparent whose value is the word "null" — and pass.
    const named = headersOf(payload({ 'message-id': 'abc', traceparent: 'null' }));

    expect(named).not.toHaveProperty('traceparent');
    expect(named['message-id']).toBe('abc');
  });

  it('answers with nothing when a message carries no headers at all', () => {
    expect(headersOf(payload({}))).toEqual({});
  });
});

/** The typings take an Error; at run time KafkaJS reads `retriable` off the argument. */
function protocolError(type: string, retriable: boolean): KafkaJSProtocolError {
  return new KafkaJSProtocolError({ type, message: type, retriable } as unknown as Error);
}

describe('createTopics', () => {
  const topics = [{ topic: 'arthome.harness.probe', partitions: 3 }];
  const transient = (): Error => protocolError('LEADER_NOT_AVAILABLE', true);

  function kafkaWith(createTopicsStub: ReturnType<typeof vi.fn>): {
    kafka: Kafka;
    disconnect: ReturnType<typeof vi.fn>;
  } {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const admin = {
      connect: vi.fn().mockResolvedValue(undefined),
      createTopics: createTopicsStub,
      disconnect,
    };
    return { kafka: { admin: () => admin } as unknown as Kafka, disconnect };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient failure, then succeeds', async () => {
    const stub = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(new KafkaJSConnectionError('down'))
      .mockResolvedValue(true);
    const { kafka, disconnect } = kafkaWith(stub);

    const done = createTopics(kafka, topics);
    await vi.runAllTimersAsync();
    await done;

    expect(stub).toHaveBeenCalledTimes(3);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('gives up after 5 attempts and throws the last error', async () => {
    const stub = vi.fn().mockRejectedValue(transient());
    const { kafka } = kafkaWith(stub);

    const done = createTopics(kafka, topics);
    const assertion = expect(done).rejects.toBeInstanceOf(KafkaJSProtocolError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(stub).toHaveBeenCalledTimes(5);
  });

  it('doubles the delay between attempts, starting at 250 ms', async () => {
    const stub = vi.fn().mockRejectedValue(transient());
    const { kafka } = kafkaWith(stub);

    const done = createTopics(kafka, topics);
    const assertion = expect(done).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(249);
    expect(stub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(stub).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub).toHaveBeenCalledTimes(3);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('throws at once on a non-retriable error', async () => {
    const fatal = protocolError('TOPIC_AUTHORIZATION_FAILED', false);
    const stub = vi.fn().mockRejectedValue(fatal);
    const { kafka, disconnect } = kafkaWith(stub);

    await expect(createTopics(kafka, topics)).rejects.toBe(fatal);

    expect(stub).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
