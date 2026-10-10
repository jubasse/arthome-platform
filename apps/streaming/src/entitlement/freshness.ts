import type { Logger } from '@nestjs/common';

import { ENTITLEMENT_PROJECTION_MAX_STALENESS_SECONDS } from '@arthome/core';

export const STALENESS_METRIC = 'read_model_staleness_seconds';

/**
 * The alert of `context-map.md` §11, a log line until the platform has metrics. Replaying a topic
 *   from the start of its retention logs every fact older than the budget, as it should.
 */
export function reportStaleness(
  logger: Logger,
  fact: { readonly type: string; readonly statedAt: Date },
  subject: string,
  appliedAtMs: number,
): void {
  const lagSeconds = (appliedAtMs - fact.statedAt.getTime()) / 1_000;
  if (lagSeconds <= ENTITLEMENT_PROJECTION_MAX_STALENESS_SECONDS) return;
  logger.warn(`${STALENESS_METRIC}=${lagSeconds.toFixed(3)} type=${fact.type} ${subject}`);
}
