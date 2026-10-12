import {
  ReplayAssetReadySchema,
  ReplayExpiredSchema,
  RunEndedSchema,
  RunStartedSchema,
} from '@arthome-platform/events';
import { RefusalException } from '@arthome-platform/http-edge';
import { PermanentError, header, messageIdOf, type Outcome } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { z } from 'zod';

import { ApiErrorCode, DomainErrorCode, RunState, isDomainError } from '@arthome/core';

import { applyChecklistMessage } from './checklist-consumer.js';
import { LearnRunFact, type RunFact } from './learn-run-fact.command.js';
import {
  LearnReplayAssetFact,
  type ReplayAssetFact,
} from '../replays/learn-replay-asset-fact.command.js';

const RUN_READERS: Readonly<Record<string, (value: Uint8Array) => RunFact>> = {
  'streaming.run.started.v1': (value) => ({
    run: RunState.ON_AIR,
    dateId: fromBinary(RunStartedSchema, value).dateId,
    endedAt: null,
  }),
  'streaming.run.ended.v1': (value) => {
    const { dateId, endedAt } = fromBinary(RunEndedSchema, value);
    // The `Replay` closes from this instant: catalog's clock would move the closing.
    if (endedAt === undefined) throw new Error('no ended_at');
    return { run: RunState.ENDED, dateId, endedAt: timestampDate(endedAt).toISOString() };
  },
};

const ASSET_READERS: Readonly<Record<string, (value: Uint8Array) => ReplayAssetFact>> = {
  'streaming.replay.asset_ready.v1': (value) => {
    const { dateId, durationSec, availableFrom, expiresAt } = fromBinary(
      ReplayAssetReadySchema,
      value,
    );
    if (availableFrom === undefined) throw new Error('no available_from');
    return {
      dateId,
      ready: {
        durationSec,
        availableFrom: timestampDate(availableFrom).toISOString(),
        expiresAt: expiresAt === undefined ? null : timestampDate(expiresAt).toISOString(),
      },
    };
  },
  'streaming.replay.expired.v1': (value) => ({
    dateId: fromBinary(ReplayExpiredSchema, value).dateId,
    ready: null,
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

/** The run's and the replay file's types to their commands, every other type to the checklist's. */
export function applyRunMessage(
  commands: CommandBus,
  payload: EachMessagePayload,
): Promise<Outcome> {
  const messageId = messageIdOf(payload);
  const type = header(payload, 'type');
  const readRun = type === null ? undefined : RUN_READERS[type];
  const readAsset = type === null ? undefined : ASSET_READERS[type];
  const traceparent = header(payload, 'traceparent');

  if (readRun !== undefined) {
    const fact = factOf(payload, messageId, readRun);
    return refusedAsPermanent(
      commands.execute(new LearnRunFact(messageId, payload.topic, fact, traceparent)),
      messageId,
      fact.dateId,
    );
  }
  if (readAsset !== undefined) {
    const fact = factOf(payload, messageId, readAsset);
    return refusedAsPermanent(
      commands.execute(new LearnReplayAssetFact(messageId, payload.topic, fact, traceparent)),
      messageId,
      fact.dateId,
    );
  }
  return applyChecklistMessage(commands, payload);
}

function factOf<F extends { readonly dateId: string }>(
  payload: EachMessagePayload,
  messageId: string,
  read: (value: Uint8Array) => F,
): F {
  const value = payload.message.value;
  if (value === null) throw new PermanentError(`message ${messageId} has no value`);
  let fact: F;
  try {
    fact = read(new Uint8Array(value));
  } catch (cause) {
    const type = header(payload, 'type');
    throw new PermanentError(`message ${messageId} does not read as ${type}: ${String(cause)}`);
  }
  if (!z.guid().safeParse(fact.dateId).success) {
    throw new PermanentError(
      `message ${messageId} names date ${JSON.stringify(fact.dateId)}, not a UUID`,
    );
  }
  return fact;
}

function refusedAsPermanent(
  applied: Promise<Outcome>,
  messageId: string,
  dateId: string,
): Promise<Outcome> {
  return applied.catch((error: unknown) => {
    const reason = refusalReason(error);
    if (reason === null) throw error;
    throw new PermanentError(`message ${messageId} is about date ${dateId}, ${reason}`);
  });
}
