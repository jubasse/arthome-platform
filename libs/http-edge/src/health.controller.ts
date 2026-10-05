import type { CheckResult } from '@arthome-platform/messaging';
import { Controller, Get, Inject, Logger } from '@nestjs/common';

import { ApiErrorCode } from '@arthome/core';

import { AllowAnonymous } from './allow-anonymous.js';
import { AllowInProduction } from './allow-in-production.js';
import { refusalOf } from './refusal.js';

export const READINESS_CHECKS: unique symbol = Symbol('READINESS_CHECKS');

export type ReadinessCheck = () => Promise<CheckResult>;

export interface ReadinessReport {
  readonly status: 'up' | 'degraded';
  readonly checks: readonly CheckResult[];
}

@AllowAnonymous()
@AllowInProduction()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  public constructor(
    @Inject(READINESS_CHECKS) private readonly checks: readonly ReadinessCheck[],
  ) {}

  // No dependency, on purpose: a failing liveness restarts the pod, and a database outage must
  //   not restart every replica of every service at once.
  // `liveness`, not `live`: here `live` is a show on air, a member of two vocabularies.
  @Get('liveness')
  public liveness(): { readonly status: 'up' } {
    return { status: 'up' };
  }

  /**
   * Only a `down` fails readiness. The operational checks answer `degraded`, which is a 200 with
   *   the detail in the body: a stopped connector must delay publishing, not take the API out of
   *   rotation.
   */
  @Get('readiness')
  public async readiness(): Promise<ReadinessReport> {
    const checks = await Promise.all(this.checks.map((check) => check()));

    const failing = checks.filter(({ status }) => status === 'down').map(({ name }) => name);
    if (failing.length > 0) {
      this.logger.error(`Not ready: ${failing.join(', ')} down.`);
      throw refusalOf(ApiErrorCode.SERVICE_UNAVAILABLE);
    }

    return {
      status: checks.some(({ status }) => status === 'degraded') ? 'degraded' : 'up',
      checks,
    };
  }
}
