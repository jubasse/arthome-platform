import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { accessorOf } from '@arthome/contracts/http';

import { IngestProtocol, type IngestAuthorizer } from '../media-ports.js';

/**
 * MX1's `POST /v1/media-server/authorize` as its seam states it (MX1 §6 S1 to S5), for the media
 *   suites until MX1 merges: Basic on a secret, `publish` on `live/<streamPath>` over webrtc or srt,
 *   the key in `token` else `password`, the decision the authorizer's; anything else 403.
 */
export interface MediaServerStandIn {
  /** The origin's `MTX_AUTHHTTPADDRESS`, reached from a container. */
  readonly authorizeUrl: string;
  readonly decisions: readonly number[];
  close(): Promise<void>;
}

/** MediaMTX's own action names; MX1 declares the same accessor. */
const MEDIA_SERVER_ACTIONS = ['publish', 'read', 'playback', 'api', 'metrics', 'pprof'] as const;
const MediaServerAction = accessorOf(MEDIA_SERVER_ACTIONS);

const PROTOCOL_OF: Readonly<Record<string, IngestProtocol>> = {
  webrtc: IngestProtocol.WHIP,
  srt: IngestProtocol.SRT,
};

interface Payload {
  readonly action?: string;
  readonly path?: string;
  readonly protocol?: string;
  readonly token?: string;
  readonly password?: string;
}

async function bodyOf(request: IncomingMessage): Promise<Payload> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}') as Payload;
}

async function decide(payload: Payload, authorizer: IngestAuthorizer): Promise<number> {
  const protocol = PROTOCOL_OF[payload.protocol ?? ''];
  const streamPath = payload.path?.startsWith('live/') ? payload.path.slice(5) : '';
  const presentedKey =
    [payload.token, payload.password].find((key) => key !== undefined && key !== '') ?? '';
  if (payload.action !== MediaServerAction.PUBLISH || protocol === undefined) return 403;
  if (streamPath === '' || streamPath.includes('/') || presentedKey === '') return 403;
  const decision = await authorizer.authorize({ streamPath, presentedKey, protocol });
  return decision.accepted ? 204 : 403;
}

export async function startMediaServerStandIn(
  authorizer: IngestAuthorizer,
): Promise<MediaServerStandIn> {
  const secret = randomBytes(16).toString('base64url');
  const expected = `Basic ${Buffer.from(`mediamtx:${secret}`).toString('base64')}`;
  const decisions: number[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const status =
        request.headers.authorization === expected
          ? await decide(await bodyOf(request), authorizer)
          : 401;
      decisions.push(status);
      response.writeHead(status).end();
    })().catch(() => response.writeHead(400).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    authorizeUrl: `http://mediamtx:${secret}@host.docker.internal:${String(port)}/v1/media-server/authorize`,
    decisions,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
