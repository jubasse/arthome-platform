#!/usr/bin/env node
// provision-topics — create the topics this repository owns, at the partition
// counts events.md §3 fixes and the retention topics.json declares, before
// anything tries to use them.
//
// WHICH BROKER: when KAFKA_BROKERS is set (comma-separated, the variable the services
//   read), the script provisions THOSE brokers through KafkaJS's admin, and an existing
//   topic's retention is aligned to topics.json. When it is not set, it keeps the
//   original behaviour: `docker compose exec kafka` on the local compose broker, where
//   a disagreement is reported and nothing is changed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import kafkajs from 'kafkajs';

const { Kafka, ConfigResourceTypes } = kafkajs;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DECLARED = JSON.parse(fs.readFileSync(path.join(REPO, 'infra/kafka/topics.json'), 'utf8'));

function kafka(args) {
  return execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'kafka',
      '/opt/kafka/bin/kafka-topics.sh',
      '--bootstrap-server',
      'localhost:9092',
      ...args,
    ],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const retentionMs = (topic) =>
  String((topic.retentionHours ?? DECLARED.retentionHours) * 3_600_000);

/** Same contract as `main`, against a KafkaJS admin: returns the exit code. */
export async function provisionWithAdmin(admin, declared, log = console) {
  const retention = (topic) =>
    String((topic.retentionHours ?? declared.retentionHours) * 3_600_000);
  const existing = new Set(await admin.listTopics());
  const missing = declared.topics.filter((topic) => !existing.has(topic.name));
  const wrong = [];
  let aligned = 0;

  if (missing.length)
    await admin.createTopics({
      waitForLeaders: true,
      topics: missing.map((topic) => ({
        topic: topic.name,
        numPartitions: topic.partitions,
        replicationFactor: 1,
        configEntries: [{ name: 'retention.ms', value: retention(topic) }],
      })),
    });

  const present = declared.topics.filter((topic) => existing.has(topic.name));
  if (present.length) {
    const { topics: metadata } = await admin.fetchTopicMetadata({
      topics: present.map((topic) => topic.name),
    });
    const { resources } = await admin.describeConfigs({
      includeSynonyms: false,
      resources: present.map((topic) => ({
        type: ConfigResourceTypes.TOPIC,
        name: topic.name,
        configNames: ['retention.ms'],
      })),
    });
    for (const topic of present) {
      // Partitions are reported, never "fixed": see the compose path below.
      const actual = metadata.find((m) => m.name === topic.name)?.partitions.length ?? 0;
      if (actual !== topic.partitions)
        wrong.push(`${topic.name}: has ${actual} partitions, declared ${topic.partitions}`);
      const entries = resources.find((r) => r.resourceName === topic.name)?.configEntries ?? [];
      const current = entries.find((e) => e.configName === 'retention.ms')?.configValue;
      if (current !== retention(topic)) {
        await admin.alterConfigs({
          validateOnly: false,
          resources: [
            {
              type: ConfigResourceTypes.TOPIC,
              name: topic.name,
              configEntries: [{ name: 'retention.ms', value: retention(topic) }],
            },
          ],
        });
        aligned += 1;
      }
    }
  }

  log.log(
    `provision-topics: ${missing.length} created, ${present.length} already present, ` +
      `${aligned} retention(s) aligned`,
  );
  if (wrong.length) {
    log.error('FAIL topics disagree with infra/kafka/topics.json — NOT changed automatically:');
    for (const w of wrong) log.error(`    ${w}`);
    return 1;
  }
  return 0;
}

async function viaBrokers(brokers) {
  const admin = new Kafka({ clientId: 'arthome-provision-topics', brokers }).admin();
  await admin.connect();
  try {
    return await provisionWithAdmin(admin, DECLARED);
  } finally {
    await admin.disconnect();
  }
}

/** The brokers `KAFKA_BROKERS` names, or null when it is unset or blank. */
export function brokersFrom(env) {
  const brokers = (env.KAFKA_BROKERS ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
  return brokers.length ? brokers : null;
}

function viaCompose() {
  const existing = new Set(
    kafka(['--list'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  let created = 0;
  const wrong = [];

  for (const topic of DECLARED.topics) {
    if (!existing.has(topic.name)) {
      kafka([
        '--create',
        '--topic',
        topic.name,
        '--partitions',
        String(topic.partitions),
        '--replication-factor',
        '1',
        '--config',
        `retention.ms=${retentionMs(topic)}`,
      ]);
      created += 1;
      continue;
    }
    // An existing topic with the wrong partition count is reported, never
    // "fixed": raising it re-hashes every key, which breaks the per-aggregate
    // ordering the key exists to guarantee, and lowering it is impossible.
    // Retention is reported too: lowering it deletes messages still waiting in a DLQ.
    const described = kafka(['--describe', '--topic', topic.name]);
    const actual = Number(/PartitionCount:\s*(\d+)/.exec(described)?.[1] ?? 0);
    if (actual !== topic.partitions)
      wrong.push(`${topic.name}: has ${actual} partitions, declared ${topic.partitions}`);
    const retention = /retention\.ms=(\d+)/.exec(described)?.[1] ?? 'the broker default';
    if (retention !== retentionMs(topic))
      wrong.push(
        `${topic.name}: retention.ms is ${retention}, declared ${retentionMs(topic)}; to apply it:\n` +
          `      kafka-configs.sh --bootstrap-server localhost:9092 --alter --entity-type topics ` +
          `--entity-name ${topic.name} --add-config retention.ms=${retentionMs(topic)}`,
      );
  }

  console.log(
    `provision-topics: ${created} created, ${DECLARED.topics.length - created} already present`,
  );
  if (wrong.length) {
    console.error('FAIL topics disagree with infra/kafka/topics.json — NOT changed automatically:');
    for (const w of wrong) console.error(`    ${w}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const brokers = brokersFrom(process.env);
  process.exit(brokers ? await viaBrokers(brokers) : viaCompose());
}
