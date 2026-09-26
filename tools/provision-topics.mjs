#!/usr/bin/env node
// provision-topics — create the topics this repository owns, at the partition
// counts events.md §3 fixes and the retention topics.json declares, before
// anything tries to use them.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

function main() {
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

process.exit(main());
