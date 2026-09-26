import type { CheckResult, CheckStatus } from '@arthome-platform/messaging';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode } from '@arthome/core';

import { HealthController, type ReadinessCheck } from './health.controller.js';
import { RefusalException } from './refusal.js';

function check(name: string, status: CheckStatus): ReadinessCheck {
  return (): Promise<CheckResult> => Promise.resolve({ name, status, detail: {} });
}

describe('HealthController', () => {
  it('answers liveness without running a single check', () => {
    const neverRun: ReadinessCheck = () => {
      throw new Error('liveness must not touch a dependency');
    };
    expect(new HealthController([neverRun]).liveness()).toEqual({ status: 'up' });
  });

  it('is up when every check is up', async () => {
    const controller = new HealthController([
      check('database', 'up'),
      check('replication_slot', 'up'),
    ]);
    expect((await controller.readiness()).status).toBe('up');
  });

  /**
   * The rule the whole design turns on: a stopped connector must delay publishing, not pull the
   *   API out of rotation. `degraded` answers 200 with the detail in the body.
   */
  it('stays ready when an operational check is degraded', async () => {
    const controller = new HealthController([
      check('database', 'up'),
      check('replication_slot', 'degraded'),
    ]);

    const report = await controller.readiness();
    expect(report.status).toBe('degraded');
    expect(report.checks.map(({ name, status }) => `${name}:${status}`)).toEqual([
      'database:up',
      'replication_slot:degraded',
    ]);
  });

  it('fails readiness with a 503 naming what is down', async () => {
    const controller = new HealthController([
      check('database', 'down'),
      check('replication_slot', 'degraded'),
    ]);

    let thrown: unknown;
    try {
      await controller.readiness();
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RefusalException);
    if (!(thrown instanceof RefusalException)) return;
    expect(thrown.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(thrown.refusal).toMatchObject({
      code: ApiErrorCode.SERVICE_UNAVAILABLE,
      params: { failing: 'database' },
    });
  });
});
