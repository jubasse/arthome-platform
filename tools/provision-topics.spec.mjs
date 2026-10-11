import { describe, expect, it, vi } from 'vitest';

import { brokersFrom, provisionWithAdmin } from './provision-topics.mjs';

const declared = {
  retentionHours: 1,
  topics: [
    { name: 'arthome.a', partitions: 3 },
    { name: 'arthome.b', partitions: 12, retentionHours: 2 },
  ],
};
const silent = { log: () => undefined, error: () => undefined };

function adminWith({ existing = [], partitions = {}, retention = {} } = {}) {
  return {
    listTopics: vi.fn().mockResolvedValue(existing),
    createTopics: vi.fn().mockResolvedValue(true),
    alterConfigs: vi.fn().mockResolvedValue({}),
    fetchTopicMetadata: vi.fn(({ topics }) =>
      Promise.resolve({
        topics: topics.map((name) => ({
          name,
          partitions: Array.from({ length: partitions[name] ?? 0 }, (_, id) => ({
            partitionId: id,
          })),
        })),
      }),
    ),
    describeConfigs: vi.fn(({ resources }) =>
      Promise.resolve({
        resources: resources.map((r) => ({
          resourceName: r.name,
          configEntries: [{ configName: 'retention.ms', configValue: retention[r.name] }],
        })),
      }),
    ),
  };
}

describe('brokersFrom', () => {
  it('splits KAFKA_BROKERS on commas', () => {
    expect(brokersFrom({ KAFKA_BROKERS: 'a:9092, b:9092' })).toEqual(['a:9092', 'b:9092']);
  });

  it('is null when unset or blank, which keeps the compose path', () => {
    expect(brokersFrom({})).toBeNull();
    expect(brokersFrom({ KAFKA_BROKERS: '  ' })).toBeNull();
  });
});

describe('provisionWithAdmin', () => {
  it('creates missing topics with partitions and retention.ms', async () => {
    const admin = adminWith();

    expect(await provisionWithAdmin(admin, declared, silent)).toBe(0);

    expect(admin.createTopics).toHaveBeenCalledWith({
      waitForLeaders: true,
      topics: [
        {
          topic: 'arthome.a',
          numPartitions: 3,
          replicationFactor: 1,
          configEntries: [{ name: 'retention.ms', value: '3600000' }],
        },
        {
          topic: 'arthome.b',
          numPartitions: 12,
          replicationFactor: 1,
          configEntries: [{ name: 'retention.ms', value: '7200000' }],
        },
      ],
    });
    expect(admin.alterConfigs).not.toHaveBeenCalled();
  });

  it('alters the retention of an existing topic and leaves a matching one alone', async () => {
    const admin = adminWith({
      existing: ['arthome.a', 'arthome.b'],
      partitions: { 'arthome.a': 3, 'arthome.b': 12 },
      retention: { 'arthome.a': '1', 'arthome.b': '7200000' },
    });

    expect(await provisionWithAdmin(admin, declared, silent)).toBe(0);

    expect(admin.createTopics).not.toHaveBeenCalled();
    expect(admin.alterConfigs).toHaveBeenCalledOnce();
    expect(admin.alterConfigs.mock.calls[0][0].resources[0]).toMatchObject({
      name: 'arthome.a',
      configEntries: [{ name: 'retention.ms', value: '3600000' }],
    });
  });

  it('reports a wrong partition count and exits 1 without touching it', async () => {
    const admin = adminWith({
      existing: ['arthome.a', 'arthome.b'],
      partitions: { 'arthome.a': 1, 'arthome.b': 12 },
      retention: { 'arthome.a': '3600000', 'arthome.b': '7200000' },
    });
    const error = vi.fn();

    expect(await provisionWithAdmin(admin, declared, { log: () => undefined, error })).toBe(1);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('arthome.a: has 1 partitions'));
    expect(admin.createTopics).not.toHaveBeenCalled();
  });
});
