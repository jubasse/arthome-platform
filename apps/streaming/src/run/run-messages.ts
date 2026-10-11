import { DateDraftedSchema } from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import { z } from 'zod';

import { PrepareRun } from './prepare-run.command.js';
import type { Reader } from '../consumed-messages.js';

/** An identifier that is no UUID names nothing here: it does not read as its type. */
function uuidOf(value: string, field: string): string {
  if (!z.uuid().safeParse(value).success) throw new Error(`${field} is not a UUID`);
  return value;
}

/** A fact with no `occurred_at` cannot be ordered against another: it does not read as its type. */
function occurredAtOf(timestamp: Timestamp | undefined): Date {
  if (timestamp === undefined) throw new Error('no occurred_at');
  return timestampDate(timestamp);
}

/** The one catalog type the run desk reads; PS2's readers take the others. */
export const RUN_READERS: Readonly<Record<string, Reader>> = {
  'catalog.date.drafted.v1': (value, delivery) => {
    const event = fromBinary(DateDraftedSchema, value);
    return new PrepareRun(delivery, {
      dateId: uuidOf(event.dateId, 'date_id'),
      channelId: uuidOf(event.channelId, 'channel_id'),
      occurredAt: occurredAtOf(event.occurredAt),
    });
  },
};
