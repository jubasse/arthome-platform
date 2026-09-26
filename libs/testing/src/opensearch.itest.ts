import { describe, expect, it, onTestFinished } from 'vitest';

import { startOpenSearch } from './stack.js';

// Container startup is measured in tens of seconds, and the first run pulls an
// image. The timeout is per test rather than global: a fast test elsewhere must
// not inherit a slow one's patience.
const STARTUP_MS = 240_000;

describe('startOpenSearch', () => {
  it(
    'serves a cluster that can be written to and read back',
    async () => {
      const opensearch = await startOpenSearch();
      onTestFinished(async () => {
        await opensearch.stop();
      });

      const { url } = opensearch.endpoint;

      // A single-node cluster reports `yellow`, never `green`: it has no
      //   second node to place a replica on. A harness that waited for green
      //   would wait until its timeout on a perfectly healthy container.
      const health = (await (await fetch(`${url}/_cluster/health`)).json()) as {
        status: string;
        number_of_nodes: number;
      };
      expect(['green', 'yellow']).toContain(health.status);
      expect(health.number_of_nodes).toBe(1);

      // Indexing and reading back is the only assertion that proves the cluster
      // is usable rather than merely answering: `/_cluster/health` returns 200
      // from a node that cannot yet accept a write.
      const written = await fetch(`${url}/harness-probe/_doc/1?refresh=wait_for`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ probe: 'written by the harness' }),
      });
      expect(written.status).toBeLessThan(300);

      const read = (await (await fetch(`${url}/harness-probe/_doc/1`)).json()) as {
        _source: { probe: string };
      };
      expect(read._source.probe).toBe('written by the harness');
    },
    STARTUP_MS,
  );
});
