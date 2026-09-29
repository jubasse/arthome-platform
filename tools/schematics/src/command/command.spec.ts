import type { UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { LIGHTING, RUN_MS, repositoryTree, testRunner } from '#schematics/repository-tree';

const SRC = '/apps/lighting/src';
const RIGS = `${SRC}/rigs`;

const FOCUS = {
  app: 'lighting',
  module: 'rigs',
  name: 'focus-rig',
  aggregate: 'rig',
  event: 'RigFocused',
  route: 'v1/rigs/:rigId/focus',
};
const DIM = {
  app: 'lighting',
  module: 'rigs',
  name: 'dim-rig',
  aggregate: 'rig',
  event: 'RigDimmed',
};

const count = (text: string, fragment: string): number => text.split(fragment).length - 1;

describe('command', () => {
  let withRig: UnitTestTree;
  let tree: UnitTestTree;

  beforeAll(async () => {
    const runner = testRunner();
    const service = await runner.runSchematic('service', LIGHTING, repositoryTree());
    withRig = await runner.runSchematic(
      'aggregate',
      { app: 'lighting', module: 'rigs', name: 'rig' },
      service,
    );
    const focused = await runner.runSchematic('command', FOCUS, withRig.branch());
    tree = await runner.runSchematic('command', DIM, focused);
  }, RUN_MS);

  it('writes the command, its handler and spec, and the route’s schema and HTTP suite', () => {
    for (const file of [
      'focus-rig.command.ts',
      'focus-rig.handler.ts',
      'focus-rig.handler.spec.ts',
      'focus-rig.schema.ts',
      'focus-rig.http.itest.ts',
      'dim-rig.command.ts',
      'dim-rig.handler.ts',
      'dim-rig.handler.spec.ts',
    ]) {
      expect(tree.exists(`${RIGS}/${file}`), file).toBe(true);
    }
    expect(tree.exists(`${RIGS}/dim-rig.schema.ts`)).toBe(false);
    expect(tree.exists(`${RIGS}/dim-rig.http.itest.ts`)).toBe(false);
  });

  it('runs the routed command idempotently in the runner, its refusals as 409, events to the outbox', () => {
    const handler = tree.readText(`${RIGS}/focus-rig.handler.ts`);
    expect(handler).toContain('this.transactions.run((transaction) =>');
    expect(handler).toContain('runIdempotentlyVersioned(');
    expect(handler).toContain('await asConflict(() => rig.focusRig(body.expectedVersion');
    expect(handler).toContain('await asConflict(() => rigs.save(rig));');
    expect(handler).toContain(
      'await recordRigEvents(manager, rig.getUncommittedEvents(), traceparent);',
    );
    expect(handler).not.toContain('commit()');
  });

  it('lets the unrouted command refuse with core’s DomainError', () => {
    const handler = tree.readText(`${RIGS}/dim-rig.handler.ts`);
    expect(handler).toContain('throw new DomainError({ code: ApiErrorCode.NOT_FOUND');
    expect(handler).not.toContain('asConflict');
  });

  it('gives the aggregate one method per command, one version guard, and an event each', () => {
    const aggregate = tree.readText(`${RIGS}/rig.aggregate.ts`);
    expect(aggregate).toContain('public focusRig(expectedVersion: number, now: Instant): void {');
    expect(aggregate).toContain('public dimRig(expectedVersion: number, now: Instant): void {');
    expect(count(aggregate, 'private advancedFrom(')).toBe(1);
    expect(aggregate.indexOf('public dimRig(')).toBeLessThan(
      aggregate.indexOf('private advancedFrom('),
    );
    expect(aggregate.indexOf('private constructor(')).toBeLessThan(
      aggregate.indexOf('public focusRig('),
    );

    const events = tree.readText(`${RIGS}/rig.events.ts`);
    expect(events).toContain('export type RigEvent = RigCreated | RigFocused | RigDimmed;');
    expect(tree.readText(`${RIGS}/record-rig-events.ts`)).toMatch(
      /case 'RigFocused':\s+case 'RigDimmed':\s+case 'RigCreated':\s+return null;/,
    );
    const spec = tree.readText(`${RIGS}/rig.aggregate.spec.ts`);
    expect(spec).toContain("it('dimRig refuses a version it was not given");
    expect(count(spec, 'function refusalOf(')).toBe(1);
  });

  it('wires the module into the API, the handlers into it, and the route into its controller', () => {
    expect(tree.readText(`${SRC}/app.module.ts`)).toContain('RigsModule]');
    const module = tree.readText(`${RIGS}/rigs.module.ts`);
    expect(module).toContain('FocusRigHandler, DimRigHandler]');
    expect(module).toContain('controllers: [RigsController]');
    const controller = tree.readText(`${RIGS}/rigs.controller.ts`);
    expect(controller).toContain("@Post('v1/rigs/:rigId/focus')");
    expect(controller).toContain("idempotentRequestOf('POST', `/v1/rigs/${rigId}/focus`");
    expect(controller.indexOf('public constructor(')).toBeLessThan(
      controller.indexOf('public focusRig('),
    );
  });

  it(
    'refuses an aggregate that does not exist, a route with another parameter, an event that exists',
    async () => {
      const refusal = (options: Record<string, unknown>): Promise<string> =>
        testRunner()
          .runSchematic('command', { ...FOCUS, ...options }, withRig.branch())
          .then(
            () => '',
            (error: unknown) => String(error),
          );
      expect(await refusal({ aggregate: 'lamp' })).toContain('does not exist');
      expect(await refusal({ route: 'v1/venues/:venueId/rigs/:rigId' })).toContain('one parameter');
      expect(await refusal({ event: 'RigCreated' })).toContain('exists already');
    },
    RUN_MS,
  );
});
