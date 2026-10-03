import type { SecurityRequirementObject } from '@nestjs/swagger';

import type { SecurityRequirement } from '@arthome/contracts/http';

export function requirementObjectOf(requirement: SecurityRequirement): SecurityRequirementObject {
  return Object.fromEntries(
    Object.entries(requirement).map(([name, scopes]) => [name, [...scopes]]),
  );
}
