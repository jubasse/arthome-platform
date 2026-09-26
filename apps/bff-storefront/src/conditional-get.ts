import { createHash } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** A weak validator over what a response says, never over its `servedAt`, which always moves. */
export function entityTagOf(representation: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(representation)).digest('base64url');
  return `W/"${digest.slice(0, 27)}"`;
}

const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');

/** RFC 9110 §13.1.2: `If-None-Match` compares weakly, and may list several tags or say `*`. */
export function noneMatch(ifNoneMatch: string | undefined, entityTag: string): boolean {
  if (ifNoneMatch === undefined) return true;
  if (ifNoneMatch.trim() === '*') return false;
  return !ifNoneMatch.split(',').some((tag) => opaque(tag) === opaque(entityTag));
}

/**
 * Nest re-applies the route's status after the handler returns, so a handler cannot answer
 *   304: `FastifyAdapter.reply` sets it back to 200 (Nest 12.0.3). The route sets the `ETag`,
 *   and this hook turns a matching conditional GET into a 304 with no body.
 */
export function answerNotModified(app: NestFastifyApplication): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (request, reply, payload) => {
      const entityTag = reply.getHeader('etag');
      const ifNoneMatch = request.headers['if-none-match'];
      if (reply.statusCode !== 200 || typeof entityTag !== 'string') return payload;
      if (noneMatch(ifNoneMatch, entityTag)) return payload;
      // Not awaited: a Fastify reply is thenable, and awaiting it here waits for its own send.
      void reply.code(304);
      return '';
    });
}
