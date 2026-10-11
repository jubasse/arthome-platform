import { guardDeclaredResponses } from '@arthome-platform/testing';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import { ApiErrorCode, RunState } from '@arthome/core';

import { MediaServerAction, MediaServerRefusal } from './media-server-attempt.js';
import {
  CASE_MS,
  MEDIA_SERVER_TEST_SECRET,
  STARTUP_MS,
  STREAM_KEY_TEST_SECRET,
  preparedRun,
  startRunDesk,
  stopRunDesk,
  type PreparedRun,
  type RunDesk,
} from '../itest/run-desk.js';
import { IngestProtocol } from '../media/media-ports.js';
import { IngestRefusal } from '../run/ingest-authorizer.js';
import { STREAM_KEY_SECRET, insertStreamKey, streamKeyOf } from '../run/stream-key.js';

/**
 * MediaMTX's external HTTP authentication as the origin posts it: its Basic credential, its JSON,
 *   no internal token and no deadline. Only the run's current key on a live path goes on the air,
 *   and no log line carries a key, the credential or the secret.
 */

const responses = guardDeclaredResponses(streamingServiceApi);

let desk: RunDesk;
const logged: string[] = [];

beforeAll(async () => {
  desk = await startRunDesk('streaming_authorize_media_server_itest', {
    watch: responses,
    mediaServer: true,
  });
  const capture = (message: unknown, ...rest: unknown[]) => {
    logged.push([message, ...rest].map((part) => JSON.stringify(part) ?? String(part)).join(' '));
  };
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(capture);
  }
}, STARTUP_MS);

afterAll(async () => {
  vi.restoreAllMocks();
  await stopRunDesk(desk);
});

function basic(password: string, user = 'mediamtx'): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

const MEDIA_SERVER = basic(MEDIA_SERVER_TEST_SECRET);

function ask(body: object, authorization: string | null = MEDIA_SERVER) {
  return desk.app.inject({
    method: 'POST',
    url: '/v1/media-server/authorize',
    headers: authorization === null ? {} : { authorization },
    payload: body,
  });
}

/** A publish as MediaMTX posts it: SRT's streamid key in `password`, WHIP's Bearer in `token`. */
function publish(run: PreparedRun, key: string, protocol: 'srt' | 'webrtc' = 'srt') {
  return ask({
    ip: '172.18.0.4',
    user: protocol === 'srt' ? 'any' : '',
    password: protocol === 'srt' ? key : '',
    token: protocol === 'webrtc' ? key : '',
    action: MediaServerAction.PUBLISH,
    path: `live/${run.streamPath}`,
    protocol,
    id: '4a1e6d1c-0b5e-4f8e-9d7a-2b9c5e1f3a77',
    query: '',
  });
}

function expectRefused(response: Awaited<ReturnType<typeof ask>>, status: 401 | 403): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({
    error: {
      code: status === 401 ? ApiErrorCode.UNAUTHENTICATED : ApiErrorCode.FORBIDDEN,
    },
  });
}

describe('authorizeMediaServerAccess', () => {
  it(
    "accepts a prepared run's current key over each ingest protocol, with no deadline sent",
    async () => {
      for (const protocol of ['srt', 'webrtc'] as const) {
        const run = await preparedRun(desk);
        const response = await publish(run, run.key, protocol);

        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
      }
    },
    CASE_MS,
  );

  it(
    "refuses another run's key and a retired generation",
    async () => {
      const run = await preparedRun(desk);
      const other = await preparedRun(desk);
      expectRefused(await publish(run, other.key), 403);

      await desk.dataSource.transaction(async (manager) => {
        await manager.query(
          'UPDATE stream_key SET retired_at = now() WHERE run_id = $1 AND generation = 1',
          [run.runId],
        );
        await insertStreamKey(
          manager,
          desk.app.get<string>(STREAM_KEY_SECRET),
          run.runId,
          2,
          desk.clock.now(),
        );
      });
      expectRefused(await publish(run, run.key, 'webrtc'), 403);
      expect(
        (await publish(run, streamKeyOf(STREAM_KEY_TEST_SECRET, run.runId, 2))).statusCode,
      ).toBe(204);
    },
    CASE_MS,
  );

  it(
    'refuses an ended run, and a second publisher while one is online',
    async () => {
      const ended = await preparedRun(desk);
      await desk.dataSource.query('UPDATE run SET state = $2, ended_at = now() WHERE id = $1', [
        ended.runId,
        RunState.ENDED,
      ]);
      expectRefused(await publish(ended, ended.key), 403);

      const busy = await preparedRun(desk);
      await desk.fake.publish(busy.streamPath, busy.key, { protocol: IngestProtocol.SRT });
      expectRefused(await publish(busy, busy.key), 403);
    },
    CASE_MS,
  );

  it(
    'refuses a read with the right secret, and a publish outside the live paths or on RTMP',
    async () => {
      const run = await preparedRun(desk);
      const live = `live/${run.streamPath}`;
      const asked = { path: live, protocol: 'srt', password: run.key };

      expectRefused(await ask({ ...asked, action: MediaServerAction.READ, protocol: 'hls' }), 403);
      expectRefused(await ask({ ...asked, action: MediaServerAction.METRICS, path: '' }), 403);
      expectRefused(
        await ask({ ...asked, action: MediaServerAction.PUBLISH, protocol: 'rtmp' }),
        403,
      );
      expectRefused(
        await ask({ ...asked, action: MediaServerAction.PUBLISH, path: run.streamPath }),
        403,
      );
      expectRefused(await ask({ ...asked, action: MediaServerAction.PUBLISH, password: '' }), 403);
      expectRefused(await ask({ ...asked, action: 'unheard-of' }), 403);
    },
    CASE_MS,
  );

  it(
    'answers 401 without the credential or with a wrong secret, and 400 on a body without action',
    async () => {
      const run = await preparedRun(desk);

      expectRefused(
        await ask(
          { action: MediaServerAction.PUBLISH, path: `live/${run.streamPath}`, protocol: 'srt' },
          null,
        ),
        401,
      );
      expectRefused(
        await ask(
          { action: MediaServerAction.PUBLISH, path: `live/${run.streamPath}`, protocol: 'srt' },
          basic(`${MEDIA_SERVER_TEST_SECRET}-not`),
        ),
        401,
      );
      const malformed = await ask({ path: `live/${run.streamPath}`, protocol: 'srt' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ error: { code: ApiErrorCode.SCHEMA_INVALID } });
    },
    CASE_MS,
  );

  it(
    'logs the reason of a refusal, and never the key, the credential, the secret or the path',
    async () => {
      const run = await preparedRun(desk);
      const wrongKey = streamKeyOf(STREAM_KEY_TEST_SECRET, run.runId, 7);
      const query = `pass=${run.key}&token=${wrongKey}`;
      logged.length = 0;

      await publish(run, wrongKey);
      await ask({
        action: MediaServerAction.READ,
        path: `live/${run.streamPath}`,
        protocol: 'webrtc',
        token: run.key,
        password: wrongKey,
        query,
      });
      await ask(
        { action: MediaServerAction.PUBLISH, path: `live/${run.streamPath}`, protocol: 'srt' },
        basic(run.key),
      );
      await ask({ path: `live/${run.streamPath}`, protocol: 'srt', password: run.key, query });

      expect(logged.some((line) => line.includes(MediaServerRefusal.NOT_A_PUBLISH))).toBe(true);
      expect(logged.some((line) => line.includes(IngestRefusal.KEY_NOT_CURRENT))).toBe(true);
      const everything = logged.join('\n');
      for (const secret of [
        run.key,
        wrongKey,
        query,
        MEDIA_SERVER_TEST_SECRET,
        MEDIA_SERVER,
        basic(run.key),
        run.streamPath,
      ]) {
        expect(everything).not.toContain(secret);
      }
    },
    CASE_MS,
  );
});
