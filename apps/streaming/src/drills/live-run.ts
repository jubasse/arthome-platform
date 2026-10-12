import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';

import {
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  DateScheduledSchema,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
} from '@arthome-platform/events';
import type { EncoderProtocol, StartedEncoder, StartedMediaStack } from '@arthome-platform/testing';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { DataSource } from 'typeorm';
import { expect, vi } from 'vitest';

import { FixedClock, SystemClock, fromEpochMs, type Instant, type RunState } from '@arthome/core';

import { CATALOG_DATE_TOPIC, wireMessage } from '../itest/entitlement.js';
import type { Playback } from '../itest/playback.js';
import { STREAM_KEY_TEST_SECRET, studioCall, type RunDesk } from '../itest/run-desk.js';
import { PrepareRun } from '../run/prepare-run.command.js';
import { streamKeyOf } from '../run/stream-key.js';

/**
 * What the real-feed drills share: a date prepared and published with an encoder on its stream
 *   path, the Envoy edge read by its playlists. A drill hands them its running pieces as a
 *   `LiveContext`, so no helper keeps state of its own.
 */

export const CHANNEL = '01a0f0cc-0000-7000-8000-0000000000d7';
export const OCCURRED_AT = timestampFromDate(new Date('2026-10-01T10:00:00.000Z'));

/** The machine's time, which a step may move forward: `FixedClock` is what the harness types. */
export class DrillClock extends FixedClock {
  private readonly system = new SystemClock();
  private offsetMs = 0;

  public constructor() {
    super(new SystemClock().nowMs());
  }

  public override nowMs(): number {
    return this.system.nowMs() + this.offsetMs;
  }

  public override now(): Instant {
    return fromEpochMs(this.nowMs());
  }

  public override advance(millis: number): Instant {
    this.offsetMs += millis;
    return this.now();
  }
}

/** The running pieces a helper reads: a drill builds it once its stack is up. */
export interface LiveContext {
  readonly clock: FixedClock;
  readonly dataSource: DataSource;
  readonly desk: RunDesk;
  readonly playback: Playback;
  readonly media: StartedMediaStack;
}

export interface LiveRun {
  readonly dateId: string;
  readonly runId: string;
  readonly streamPath: string;
  readonly key: string;
  encoder: StartedEncoder | null;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function scheduledDate(live: LiveContext, replayPolicy: WireReplayPolicy): Promise<string> {
  const dateId = randomUUID();
  for (const message of [
    wireMessage(CATALOG_DATE_TOPIC, 'catalog.date.scheduled.v1', DateScheduledSchema, dateId, {
      dateId,
      channelId: CHANNEL,
      startsAt: timestampFromDate(new Date(live.clock.now())),
      runtimeMin: 90,
      replayPolicy,
      replayWindowHours: replayPolicy === WireReplayPolicy.NONE ? 0 : 48,
      rights: { scope: WireRightsScope.WORLDWIDE },
      occurredAt: OCCURRED_AT,
    }),
    publication(dateId, WirePublicationState.TECHNICAL, 1n),
  ]) {
    await live.playback.apply(message);
  }
  return dateId;
}

export function publication(dateId: string, toState: WirePublicationState, version: bigint) {
  return wireMessage(
    CATALOG_DATE_TOPIC,
    'catalog.publication.state_changed.v1',
    PublicationStateChangedSchema,
    dateId,
    { dateId, channelId: CHANNEL, toState, version, occurredAt: OCCURRED_AT },
  );
}

export async function preparedRun(
  live: LiveContext,
  replayPolicy = WireReplayPolicy.NONE,
): Promise<LiveRun> {
  const dateId = await scheduledDate(live, replayPolicy);
  await live.desk.commands.execute(
    new PrepareRun(
      { messageId: randomUUID(), topic: CATALOG_DATE_TOPIC, traceparent: null },
      { dateId, channelId: CHANNEL, occurredAt: new Date(live.clock.now()) },
    ),
  );
  const [run] = await live.dataSource.query<{ id: string; stream_path: string }[]>(
    'SELECT id, stream_path FROM run WHERE date_id = $1',
    [dateId],
  );
  if (run === undefined) throw new Error('no run prepared');
  return {
    dateId,
    runId: run.id,
    streamPath: run.stream_path,
    key: streamKeyOf(STREAM_KEY_TEST_SECRET, run.id, 1),
    encoder: null,
  };
}

export async function runRow(live: LiveContext, run: LiveRun) {
  const [row] = await live.dataSource.query<
    { state: RunState; publisher_online_since: Date | null; version: number }[]
  >('SELECT state, publisher_online_since, version FROM run WHERE id = $1', [run.runId]);
  return row;
}

export async function publish(
  live: LiveContext,
  run: LiveRun,
  protocol: EncoderProtocol,
): Promise<void> {
  // eslint-disable-next-line no-param-reassign -- the drill's run carries its encoder.
  run.encoder = await live.media.startEncoder({
    protocol,
    streamPath: run.streamPath,
    key: run.key,
  });
  await vi.waitFor(
    async () => expect((await runRow(live, run))?.publisher_online_since).not.toBeNull(),
    {
      timeout: 45_000,
      interval: 250,
    },
  );
}

export async function onAir(
  live: LiveContext,
  run: LiveRun,
  protocol: EncoderProtocol,
): Promise<unknown> {
  await publish(live, run, protocol);
  const check = await vi.waitFor(
    async () => {
      const answer = await studioCall(
        live.desk,
        'POST',
        `/v1/dates/${run.dateId}/run/technical-check`,
      );
      const body = answer.json<unknown>();
      expect(body).toMatchObject({ data: { passed: true } });
      return body;
    },
    { timeout: 20_000, interval: 1_000 },
  );
  const onAirAnswer = await studioCall(live.desk, 'POST', `/v1/dates/${run.dateId}/run/go-on-air`, {
    body: { expectedVersion: 2 },
  });
  expect(onAirAnswer.statusCode, onAirAnswer.body).toBe(200);
  await live.playback.apply(publication(run.dateId, WirePublicationState.LIVE, 2n));
  return check;
}

export async function edgeGet(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

/** The date's media playlist through Envoy, with its sequence and its newest segment. */
export async function mediaPlaylist(manifestUrl: string, token: string) {
  const multivariant = await edgeGet(`${manifestUrl}?token=${token}`);
  const mediaUri = multivariant.body.split('\n').find((line) => line.endsWith('.m3u8'));
  if (multivariant.status !== 200 || mediaUri === undefined) {
    return {
      status: multivariant.status,
      multivariant: multivariant.body,
      body: '',
      sequence: -1,
      segment: '',
    };
  }
  const media = await edgeGet(`${new URL(mediaUri, manifestUrl).href}?token=${token}`);
  const sequence = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(media.body)?.[1] ?? -1);
  const segment =
    media.body
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .at(-1) ?? '';
  return {
    status: media.status,
    multivariant: multivariant.body,
    body: media.body,
    sequence,
    segment: new URL(segment, manifestUrl).href,
  };
}
