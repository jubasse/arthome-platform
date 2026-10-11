import { readPlaybackSigningKey } from '@arthome-platform/config';
import { RunStateChangedSchema } from '@arthome-platform/events';
import {
  MEDIA_STACK_STOP_MS,
  startMediaStack,
  type StartedMediaStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PUBLISHER_GRACE_SECONDS, SystemClock } from '@arthome/core';

import { startMediaServerStandIn, type MediaServerStandIn } from './media-server-stand-in.js';
import { readMediaMtxEnv } from './mediamtx-env.js';
import { MediaMtxStreamingProvider } from './mediamtx-streaming-provider.js';
import {
  STARTUP_MS,
  feedOn,
  outboxOf,
  preparedRun,
  startRunDesk,
  stopRunDesk,
  studioCall,
  type RunDesk,
} from '../../itest/run-desk.js';
import { RunIngestAuthorizer } from '../../run/ingest-authorizer.js';
import { RunIngestListener } from '../../run/ingest-listener.js';
import { SweepRunPresence } from '../../run/run-passes.js';

const CASE_MS = 90_000;

let desk: RunDesk;
let stack: StartedMediaStack;
let standIn: MediaServerStandIn;
const replicas: MediaMtxStreamingProvider[] = [];

beforeAll(async () => {
  desk = await startRunDesk('streaming_lifecycle_replicas_itest');
  standIn = await startMediaServerStandIn(desk.app.get(RunIngestAuthorizer));
  stack = await startMediaStack({ authorizeUrl: standIn.authorizeUrl });
  for (let replica = 0; replica < 2; replica += 1) {
    const provider = new MediaMtxStreamingProvider({
      env: readMediaMtxEnv(stack.providerEnv),
      signingKey: readPlaybackSigningKey({ NODE_ENV: 'test' }),
      clock: new SystemClock(),
    });
    provider.attachIngestHooks({
      authorizer: desk.app.get(RunIngestAuthorizer),
      listener: desk.app.get(RunIngestListener),
    });
    replicas.push(provider);
  }
}, STARTUP_MS);

afterAll(async () => {
  for (const provider of replicas) await provider.beforeApplicationShutdown();
  await stack.stop();
  await standIn.close();
  await stopRunDesk(desk);
}, MEDIA_STACK_STOP_MS);

describe('two API replicas watching one origin', () => {
  it(
    'lift the lost feed once: one publisherBack for one return',
    async () => {
      const run = await preparedRun(desk);
      await feedOn(desk, run);
      await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/technical-check`);
      await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/go-on-air`, {
        body: { expectedVersion: 2 },
      });
      await desk.fake.drop(run.streamPath);
      desk.clock.advance(PUBLISHER_GRACE_SECONDS * 1000);
      await desk.commands.execute(new SweepRunPresence());
      const written = (await outboxOf(desk, run.dateId)).length;

      const encoder = await stack.startEncoder({
        protocol: 'whip',
        streamPath: run.streamPath,
        key: run.key,
      });
      await vi.waitFor(
        async () => {
          const [row] = await desk.dataSource.query<{ after_grace_period: boolean }[]>(
            'SELECT after_grace_period FROM run WHERE id = $1',
            [run.runId],
          );
          expect(row?.after_grace_period).toBe(false);
        },
        { timeout: 30_000, interval: 250 },
      );
      // Several ticks of both watchers.
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      const rows = (await outboxOf(desk, run.dateId)).slice(written);
      expect(rows.map(({ type }) => type)).toEqual(['streaming.run.state_changed.v1']);
      expect(
        fromBinary(RunStateChangedSchema, rows[0]?.payload ?? Buffer.alloc(0)).afterGracePeriod,
      ).toBe(false);
      await encoder.stop();
    },
    CASE_MS,
  );
});
