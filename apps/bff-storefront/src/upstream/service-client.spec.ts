import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { readInternalTokenSigningKey } from '@arthome-platform/config';
import { DEADLINE_HEADER } from '@arthome-platform/http-edge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Service, SystemClock } from '@arthome/core';

import { ServiceClient } from './service-client.js';
import { InternalTokenMinter } from '../internal-token.minter.js';

let received: IncomingHttpHeaders = {};
let server: Server;
let client: ServiceClient;

beforeAll(async () => {
  server = createServer((request, response) => {
    received = request.headers;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  client = new ServiceClient(
    Service.IDENTITY,
    `http://localhost:${(server.address() as AddressInfo).port}`,
    new InternalTokenMinter(readInternalTokenSigningKey({ NODE_ENV: 'test' }), new SystemClock()),
  );
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('a call to a service', () => {
  it('relays its headers, and none of them replaces the token or the deadline', async () => {
    const deadline = new Date(Date.now() + 1_000);
    await client.request(
      {
        method: 'POST',
        path: '/v1/anything',
        headers: {
          authorization: 'Bearer forged',
          [DEADLINE_HEADER]: '2099-01-01T00:00:00.000Z',
          'idempotency-key': 'a-key',
        },
      },
      { deadline, traceparent: '', callerLeft: new AbortController().signal, caller: null },
      z.looseObject({ data: z.looseObject({}) }),
    );

    expect(received['idempotency-key']).toBe('a-key');
    expect(received.authorization).not.toBe('Bearer forged');
    expect(received.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(received[DEADLINE_HEADER]).toBe(deadline.toISOString());
  });
});
