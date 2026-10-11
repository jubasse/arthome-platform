import { RunEndedSchema, RunStartedSchema } from '@arthome-platform/events';
import { RefusalException } from '@arthome-platform/http-edge';
import { PermanentError, header, messageIdOf, type Outcome } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { z } from 'zod';

import { ApiErrorCode, DomainErrorCode, RunState, isDomainError } from '@arthome/core';

import { applyChecklistMessage } from './checklist-consumer.js';
import { LearnRunFact, type RunFact } from './learn-run-fact.command.js';

const READERS: Readonly<Record<string, (value: Uint8Array) => RunFact>> = {
  'streaming.run.started.v1': (value) => ({
    run: RunState.ON_AIR,
    dateId: fromBinary(RunStartedSchema, value).dateId,
  }),
  'streaming.run.ended.v1': (value) => ({
    run: RunState.ENDED,
    dateId: fromBinary(RunEndedSchema, value).dateId,
  }),
};

/** A version conflict with a studio command is the one refusal a retry changes. */
function refusalReason(error: unknown): string | null {
  if (isDomainError(error)) {
    return error.code === DomainErrorCode.STATE_CONFLICT ? null : `refused ${error.code}`;
  }
  if (error instanceof RefusalException && error.refusal.code === ApiErrorCode.NOT_FOUND) {
    return 'unknown here';
  }
  return null;
}

export function applyRunMessage(
  commands: CommandBus,
  payload: EachMessagePayload,
): Promise<Outcome> {
  const messageId = messageIdOf(payload);
  const type = header(payload, 'type');
  const read = type === null ? undefined : READERS[type];
  if (read === undefined) return applyChecklistMessage(commands, payload);

  const value = payload.message.value;
  if (value === null) throw new PermanentError(`message ${messageId} has no value`);
  let fact: RunFact;
  try {
    fact = read(new Uint8Array(value));
  } catch (cause) {
    throw new PermanentError(`message ${messageId} does not read as ${type}: ${String(cause)}`);
  }

  if (!z.guid().safeParse(fact.dateId).success) {
    throw new PermanentError(
      `message ${messageId} names date ${JSON.stringify(fact.dateId)}, not a UUID`,
    );
  }

  return commands
    .execute(new LearnRunFact(messageId, payload.topic, fact, header(payload, 'traceparent')))
    .catch((error: unknown) => {
      const reason = refusalReason(error);
      if (reason === null) throw error;
      throw new PermanentError(`message ${messageId} is about date ${fact.dateId}, ${reason}`);
    });
}
