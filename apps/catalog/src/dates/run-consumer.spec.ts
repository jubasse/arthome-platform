import { RunEndedSchema, RunStartedSchema } from '@arthome-platform/events';
import { RefusalException, notFound } from '@arthome-platform/http-edge';
import { PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { DomainError, DomainErrorCode, PublicationState, RunState } from '@arthome/core';

import { LearnRunFact } from './learn-run-fact.command.js';
import { applyRunMessage } from './run-consumer.js';

const DATE_ID = '01a0e5bb-0000-7000-8000-0000000000d1';
const MESSAGE_ID = '01a0e5bb-0000-7000-8000-000000000001';

function message(type: string, value: Uint8Array | null, traceparent: string | null = null) {
  return {
    topic: 'arthome.streaming.run',
    partition: 0,
    message: {
      key: Buffer.from('date-1'),
      value: value === null ? null : Buffer.from(value),
      headers: {
        'message-id': Buffer.from(MESSAGE_ID),
        type: Buffer.from(type),
        ...(traceparent !== null && { traceparent: Buffer.from(traceparent) }),
      },
    },
  } as unknown as EachMessagePayload;
}

function busAnswering(answer: () => Promise<unknown>): { bus: CommandBus; sent: unknown[] } {
  const sent: unknown[] = [];
  const bus = {
    execute: (command: unknown) => {
      sent.push(command);
      return answer();
    },
  } as unknown as CommandBus;
  return { bus, sent };
}

const started = toBinary(RunStartedSchema, create(RunStartedSchema, { dateId: DATE_ID }));
const ended = toBinary(RunEndedSchema, create(RunEndedSchema, { dateId: DATE_ID }));

describe('applyRunMessage', () => {
  it.each([
    ['streaming.run.started.v1', started, RunState.ON_AIR],
    ['streaming.run.ended.v1', ended, RunState.ENDED],
  ] as const)('reads %s into a fact about its date', async (type, value, run) => {
    const { bus, sent } = busAnswering(() => Promise.resolve('applied'));

    await expect(applyRunMessage(bus, message(type, value))).resolves.toBe('applied');

    expect(sent).toEqual([
      new LearnRunFact(MESSAGE_ID, 'arthome.streaming.run', { dateId: DATE_ID, run }, null),
    ]);
  });

  it('hands every other type to the checklist consumer, which ignores this one', async () => {
    const { bus, sent } = busAnswering(() => Promise.reject(new Error('no command expected')));

    await expect(
      applyRunMessage(bus, message('streaming.run.state_changed.v1', new Uint8Array([1]))),
    ).resolves.toBe('ignored');
    expect(sent).toEqual([]);
  });

  it('refuses a message with no value as permanent', () => {
    const { bus } = busAnswering(() => Promise.resolve('applied'));

    expect(() => applyRunMessage(bus, message('streaming.run.started.v1', null))).toThrow(
      PermanentError,
    );
  });

  it('refuses a value that does not read as its type as permanent, naming the message', () => {
    const { bus } = busAnswering(() => Promise.resolve('applied'));

    expect(() =>
      applyRunMessage(bus, message('streaming.run.started.v1', new Uint8Array([0xff, 0xff]))),
    ).toThrow(new RegExp(`${MESSAGE_ID} does not read as streaming.run.started.v1`));
  });

  it('carries the inbound traceparent to the command', async () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const { bus, sent } = busAnswering(() => Promise.resolve('applied'));

    await applyRunMessage(bus, message('streaming.run.started.v1', started, traceparent));

    expect(sent).toEqual([
      new LearnRunFact(
        MESSAGE_ID,
        'arthome.streaming.run',
        { dateId: DATE_ID, run: RunState.ON_AIR },
        traceparent,
      ),
    ]);
  });

  it('refuses a date id that is not a UUID as permanent, before any command', () => {
    const { bus, sent } = busAnswering(() => Promise.resolve('applied'));
    const notAUuid = toBinary(RunStartedSchema, create(RunStartedSchema, { dateId: 'date-1' }));

    expect(() => applyRunMessage(bus, message('streaming.run.started.v1', notAUuid))).toThrow(
      PermanentError,
    );
    expect(sent).toEqual([]);
  });

  it('dead-letters a refused transition at once', async () => {
    const refusal = new DomainError({
      code: DomainErrorCode.PUBLICATION_TRANSITION_FORBIDDEN,
      params: { from: PublicationState.SCHEDULED, to: PublicationState.LIVE },
    });
    const { bus } = busAnswering(() => Promise.reject(refusal));

    await expect(
      applyRunMessage(bus, message('streaming.run.started.v1', started)),
    ).rejects.toThrow(new RegExp(`${DATE_ID}, refused publication.transition_forbidden`));
  });

  it('dead-letters a date catalog does not know', async () => {
    const { bus } = busAnswering(() => Promise.reject(notFound()));

    const failure: unknown = await applyRunMessage(
      bus,
      message('streaming.run.ended.v1', ended),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PermanentError);
    expect(failure).not.toBeInstanceOf(RefusalException);
  });

  it('retries a version conflict with a studio command, and anything else unknown', async () => {
    const conflict = new DomainError({
      code: DomainErrorCode.STATE_CONFLICT,
      params: { currentVersion: 3, state: PublicationState.TECHNICAL },
    });
    for (const failure of [conflict, new Error('Connection terminated unexpectedly')]) {
      const { bus } = busAnswering(() => Promise.reject(failure));
      await expect(applyRunMessage(bus, message('streaming.run.started.v1', started))).rejects.toBe(
        failure,
      );
    }
  });
});
