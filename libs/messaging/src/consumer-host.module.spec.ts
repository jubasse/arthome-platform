import type { CommandBus } from '@nestjs/cqrs';
import type { ConsumerRunConfig, EachMessagePayload, Kafka } from 'kafkajs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsumerHost } from './consumer-host.module.js';
import { Outcome } from './dispatch.js';

const COMMANDS = {} as unknown as CommandBus;

function recordingKafka(): { readonly kafka: Kafka; readonly calls: string[] } {
  const calls: string[] = [];
  const kafka = {
    producer: () => ({
      connect: () => Promise.resolve(calls.push('producer connect')),
      disconnect: () => Promise.resolve(calls.push('producer disconnect')),
    }),
    consumer: ({ groupId }: { groupId: string }) => ({
      connect: () => Promise.resolve(),
      subscribe: ({ topics }: { topics: string[] }) =>
        Promise.resolve(calls.push(`${groupId} subscribes ${topics.join(' ')}`)),
      run: ({ eachMessage }: ConsumerRunConfig) =>
        eachMessage?.({
          topic: 'arthome.harness.probe',
          partition: 0,
          message: { headers: {} },
          heartbeat: () => Promise.resolve(),
        } as unknown as EachMessagePayload),
      disconnect: () => Promise.resolve(calls.push(`${groupId} disconnect`)),
    }),
  } as unknown as Kafka;
  return { kafka, calls };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConsumerHost', () => {
  it('subscribes its topics and its retry topic, each message applied with the command bus', async () => {
    const { kafka, calls } = recordingKafka();
    const apply = vi.fn(() => Promise.resolve(Outcome.APPLIED));
    const host = new ConsumerHost(kafka, COMMANDS, {
      service: 'harness',
      topics: ['arthome.harness.probe'],
      apply,
    });

    await host.onApplicationBootstrap();

    expect(calls).toEqual([
      'producer connect',
      'harness subscribes arthome.harness.probe',
      'harness-retry subscribes arthome.harness.retry',
    ]);
    expect(apply).toHaveBeenCalledWith(COMMANDS, expect.objectContaining({ partition: 0 }));
  });

  it('stops its consumers before its producer, on shutdown', async () => {
    const { kafka, calls } = recordingKafka();
    const host = new ConsumerHost(kafka, COMMANDS, {
      service: 'harness',
      topics: ['arthome.harness.probe'],
      apply: () => Promise.resolve(Outcome.APPLIED),
    });
    await host.onApplicationBootstrap();
    calls.length = 0;

    await host.onApplicationShutdown();

    expect(calls).toEqual([
      'harness disconnect',
      'harness-retry disconnect',
      'producer disconnect',
    ]);
  });
});
