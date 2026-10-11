import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { IngestAuthorizer } from '../media/media-ports.js';
import { attemptOf, type MediaServerAuthorization } from '../media-server/media-server-attempt.js';

/**
 * MX1's route without the app: its Basic check and its own mapping (`attemptOf`), the decision a
 *   suite's authorizer. For the suites that need no database; the drill calls the real route.
 */
export interface MediaServerStandIn {
  /** The origin's `MTX_AUTHHTTPADDRESS`, reached from a container. */
  readonly authorizeUrl: string;
  readonly decisions: readonly number[];
  close(): Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<MediaServerAuthorization> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString()) as MediaServerAuthorization;
}

async function decide(
  request: MediaServerAuthorization,
  authorizer: IngestAuthorizer,
): Promise<number> {
  const asked = attemptOf(request);
  if (!('attempt' in asked)) return 403;
  return (await authorizer.authorize(asked.attempt)).accepted ? 204 : 403;
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
