import {
  LanguageDependency as WireLanguageDependency,
  ShowPublishedSchema,
} from '@arthome-platform/events';
import { OutboxEvent } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { LanguageDependency, rendition } from '@arthome/core';

import { PublishShowService } from './publish-show.service.js';
import { Show } from './show.entity.js';

interface Insert {
  readonly target: unknown;
  readonly values: Record<string, unknown>;
  readonly manager: object;
}

/** A DataSource that records what was inserted, and through which manager. */
function recordingDataSource(inserts: Insert[]): DataSource {
  const manager = {
    insert: (target: unknown, values: Record<string, unknown>) => {
      inserts.push({ target, values, manager });
      return Promise.resolve();
    },
  };
  return {
    transaction: (run: (m: EntityManager) => Promise<unknown>) =>
      run(manager as unknown as EntityManager),
  } as unknown as DataSource;
}

// BUILT FROM `@arthome/core`'s `rendition()`, not from an object literal. The
//   floor forbids hand-building a value the domain can produce (§5.8): that is a
//   parallel literal table with a fixture's costume.
const command = {
  channelId: '01931f00-0000-7000-8000-000000000001',
  artistId: '01931f00-0000-7000-8000-000000000002',
  categoryId: 'theatre',
  genreIds: ['contemporary', 'repertoire'],
  tagIds: ['revival'],
  runtimeMin: 95,
  languageDependency: LanguageDependency.ESSENTIAL,
  spokenLanguages: ['fr'],
  subtitleLanguages: ['en'],
  surtitleLanguages: [],
  media: {
    wide: [rendition('https://cdn.example.test/w-640.jpg', 640, 360)],
    poster: [rendition('https://cdn.example.test/p-480.jpg', 480, 720)],
  },
  title: { fr: 'Nuit blanche', en: '' },
  synopsis: { fr: '', en: '' },
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
};

describe('PublishShowService', () => {
  it('writes the show and the outbox row through ONE manager', async () => {
    const inserts: Insert[] = [];
    await new PublishShowService(recordingDataSource(inserts)).publish(command);

    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.target).toBe(Show);
    expect(inserts[1]?.target).toBe(OutboxEvent);
    // The guarantee is not "both happened", it is "both happened in the same
    // transaction". A different manager here would mean two transactions, and
    // a crash between them loses the event or invents it.
    expect(inserts[0]?.manager).toBe(inserts[1]?.manager);
  });

  it('routes by aggregate, and keys by the show so one show stays ordered', async () => {
    const inserts: Insert[] = [];
    const result = await new PublishShowService(recordingDataSource(inserts)).publish(command);
    const outbox = inserts[1]?.values ?? {};

    expect(outbox.aggregatetype).toBe('catalog.show');
    expect(outbox.aggregateid).toBe(result.showId);
    expect(outbox.type).toBe('catalog.show.published.v1');
  });

  it('injects the traceparent at WRITE time, not at publication time', async () => {
    const inserts: Insert[] = [];
    await new PublishShowService(recordingDataSource(inserts)).publish(command);
    expect(inserts[1]?.values.tracecontext).toBe(command.traceparent);
  });

  it('carries no traceparent rather than inventing one', async () => {
    const inserts: Insert[] = [];
    await new PublishShowService(recordingDataSource(inserts)).publish({
      ...command,
      traceparent: null,
    });
    expect(inserts[1]?.values.tracecontext).toBeNull();
  });

  it('writes a payload that decodes back to the event', async () => {
    const inserts: Insert[] = [];
    const result = await new PublishShowService(recordingDataSource(inserts)).publish(command);

    const payload = inserts[1]?.values.payload as Buffer;
    const decoded = fromBinary(ShowPublishedSchema, new Uint8Array(payload));
    expect(decoded.showId).toBe(result.showId);
    expect(decoded.channelId).toBe(command.channelId);
    expect(decoded.genreIds).toEqual([...command.genreIds]);
    expect(decoded.runtimeMin).toBe(command.runtimeMin);
    // The nested message survives the round trip, which is the half a scalar-only
    // payload would not have proved.
    expect(decoded.media?.wide[0]?.widthPx).toBe(640);
    expect(decoded.media?.poster[0]?.url).toBe(command.media.poster[0]?.url);
  });

  it('encodes the language dependency as the wire number, not as its domain spelling', async () => {
    const inserts: Insert[] = [];
    await new PublishShowService(recordingDataSource(inserts)).publish(command);

    const payload = inserts[1]?.values.payload as Buffer;
    const decoded = fromBinary(ShowPublishedSchema, new Uint8Array(payload));
    // NOT `UNSPECIFIED`. A member that fails to encode falls to 0 silently, and
    //   the fact then arrives saying nothing about the field a surface's most
    //   visible language rule reads.
    expect(decoded.languageDependency).toBe(WireLanguageDependency.ESSENTIAL);
    // The row keeps the domain's spelling; only the wire carries the number.
    expect(inserts[0]?.values.language_dependency).toBe(LanguageDependency.ESSENTIAL);
  });

  it('gives the message an identifier of its own, distinct from the show', async () => {
    const inserts: Insert[] = [];
    const result = await new PublishShowService(recordingDataSource(inserts)).publish(command);
    // The message-id deduplicates deliveries; the show id identifies a work.
    // Reusing one for the other makes a second event about the same show look
    // like a duplicate of the first, and consumers silently drop it.
    expect(result.messageId).not.toBe(result.showId);
    expect(inserts[1]?.values.id).toBe(result.messageId);
  });

  it('records no actor, because this slice has no verified one', async () => {
    const inserts: Insert[] = [];
    await new PublishShowService(recordingDataSource(inserts)).publish(command);
    // Asserted rather than left implicit: the day an authenticated actor exists,
    // this test is what says the column was deliberately empty and not forgotten.
    expect(inserts[1]?.values.actor_id).toBeNull();
  });
});
