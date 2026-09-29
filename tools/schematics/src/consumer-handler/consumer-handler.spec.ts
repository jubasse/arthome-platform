import type { Tree } from '@angular-devkit/schematics';
import type { UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { LIGHTING, RUN_MS, repositoryTree, testRunner } from '#schematics/repository-tree';

const SRC = '/apps/lighting/src';

const DRAFTED = {
  app: 'lighting',
  module: 'dates',
  name: 'record-date-drafted',
  topic: 'arthome.catalog.date',
  type: 'catalog.date.drafted.v1',
  schema: 'DateDraftedSchema',
  key: 'dateId',
};
const SCHEDULED = {
  ...DRAFTED,
  name: 'record-date-scheduled',
  type: 'catalog.date.scheduled.v1',
  schema: 'DateScheduledSchema',
};

const count = (text: string, fragment: string): number => text.split(fragment).length - 1;

describe('consumer-handler', () => {
  let service: UnitTestTree;
  let tree: UnitTestTree;

  beforeAll(async () => {
    const runner = testRunner();
    service = await runner.runSchematic('service', LIGHTING, repositoryTree());
    const drafted = await runner.runSchematic('consumer-handler', DRAFTED, service.branch());
    tree = await runner.runSchematic('consumer-handler', SCHEDULED, drafted);
  }, RUN_MS);

  it('writes the command, its handler, its reader spec and its integration suite', () => {
    for (const file of [
      'record-date-drafted.command.ts',
      'record-date-drafted.handler.ts',
      'record-date-drafted.message.spec.ts',
      'record-date-drafted.handler.itest.ts',
      'dates-consumer.module.ts',
    ]) {
      expect(tree.exists(`${SRC}/dates/${file}`), file).toBe(true);
    }
  });

  it('claims the message in the transaction that keeps the fact, and refuses an older one', () => {
    const handler = tree.readText(`${SRC}/dates/record-date-drafted.handler.ts`);
    expect(handler).toContain('this.transactions.run(async ({ manager }) => {');
    expect(handler).toContain('claimMessage(manager, delivery.messageId, delivery.topic)');
    expect(handler).toContain('return Outcome.DUPLICATE;');
    expect(handler).toContain('WHERE excluded.occurred_at >= date_drafted_fact.occurred_at');
    expect(handler).toContain('Outcome.APPLIED : Outcome.SUPERSEDED');
  });

  it('reads each type into its command, with one occurred_at reader', () => {
    const messages = tree.readText(`${SRC}/consumed-messages.ts`);
    expect(messages).toContain("'catalog.date.drafted.v1': (value, delivery) => {");
    expect(messages).toContain("'catalog.date.scheduled.v1': (value, delivery) => {");
    expect(messages).toContain('occurredAt: occurredAtOf(event.occurredAt),');
    expect(count(messages, 'function occurredAtOf(')).toBe(1);
  });

  it('subscribes the topic once, and provides both handlers in one consumer module', () => {
    const consumer = tree.readText(`${SRC}/consumer.module.ts`);
    expect(consumer).toContain("CONSUMED_TOPICS: readonly string[] = ['arthome.catalog.date'];");
    expect(count(consumer, 'DatesConsumerModule')).toBe(2);
    expect(tree.readText(`${SRC}/dates/dates-consumer.module.ts`)).toContain(
      'providers: [RecordDateDraftedHandler, RecordDateScheduledHandler]',
    );
    expect(tree.readText(`${SRC}/data-source.ts`)).toMatch(
      /DateDraftedFact\d{13}, DateScheduledFact\d{13}\]/,
    );
  });

  it(
    'refuses an app without a consumer, and a schema that is not one',
    async () => {
      const apiOnly = await testRunner().runSchematic(
        'service',
        { ...LIGHTING, consumer: false },
        repositoryTree(),
      );
      const refusal = (options: Record<string, unknown>, on: Tree): Promise<string> =>
        testRunner()
          .runSchematic('consumer-handler', { ...DRAFTED, ...options }, on)
          .then(
            () => '',
            (error: unknown) => String(error),
          );
      expect(await refusal({}, apiOnly)).toContain('--consumer');
      expect(await refusal({ schema: 'DateDrafted' }, service.branch())).toContain('--schema');
    },
    RUN_MS,
  );
});
