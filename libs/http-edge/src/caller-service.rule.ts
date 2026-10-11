import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

import type { Requirement } from '@arthome/contracts/http';
import { ApiErrorCode, INTERNAL_TOKEN_ISSUERS } from '@arthome/core';

import type { RuleGuard } from './endpoint-access.js';
import { refusalOf } from './refusal.js';

function issuersOf(rule: Requirement): readonly unknown[] {
  const { issuers } = rule.params as { readonly issuers?: unknown };
  return Array.isArray(issuers) ? issuers : [];
}

/**
 * Core's `callerService` rule: the BFFs a service route serves, by the verified token's issuer.
 *   Any other caller is refused 403 `api.forbidden`, whatever account it names.
 */
@Injectable()
export class CallerServiceRule implements RuleGuard {
  public check(_context: ExecutionContext, rule: Requirement, principal: unknown): Promise<void> {
    const callingService = (principal as { readonly callingService?: unknown } | null | undefined)
      ?.callingService;
    if (!issuersOf(rule).includes(callingService)) {
      return Promise.reject(refusalOf(ApiErrorCode.FORBIDDEN));
    }
    return Promise.resolve();
  }

  public problemWith(rule: Requirement): string | undefined {
    const issuers = issuersOf(rule);
    if (issuers.length === 0) return 'it names no issuer';
    const unknown = issuers.filter(
      (issuer) => !(INTERNAL_TOKEN_ISSUERS as readonly unknown[]).includes(issuer),
    );
    return unknown.length === 0
      ? undefined
      : `no BFF mints as ${unknown.map((issuer) => JSON.stringify(issuer)).join(', ')}`;
  }
}
