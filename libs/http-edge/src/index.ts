// NOT A BARREL OVER A WHOLE TREE. §5.5 discourages those (D-012: zod's barrel made
// 64 translation files reachable, 93 KB gzip against 7.5 KB, at a FIXED cost). These
// are a few modules with one purpose, named individually, in a library no bundler
// ships to a browser — the two reasons the rule exists do not apply.

export { ErrorEnvelopeFilter } from './error-envelope.filter.js';

export {
  RefusalException,
  domainRefusal,
  isMappedStatus,
  isPublishedCode,
  notFound,
  refusalForStatus,
  refusalCausedBy,
  refusalOf,
  refuse,
  schemaInvalidException,
  stateConflict,
} from './refusal.js';
export type {
  DeclaredCodeOf,
  ParamlessErrorCode,
  Refusal,
  UniqueViolationCode,
} from './refusal.js';

export { DenyInProductionGuard } from './deny-in-production.guard.js';

export { AllowAnonymous } from './allow-anonymous.js';
export { InternalTokenGuard, ServiceIdentity } from './internal-token.guard.js';
export { CallerServiceRule } from './caller-service.rule.js';
export { InternalTokenVerifier } from './internal-token.verifier.js';
export {
  CurrentPrincipal,
  accountOf,
  attachPrincipal,
  principalOf,
  unauthenticated,
} from './principal.js';
export type { Principal } from './principal.js';

export { edgeProviders } from './edge-providers.js';
export { JsonBodiesOnly } from './json-bodies-only.js';
export type { EdgeOptions } from './edge-providers.js';

export {
  DEADLINE_HEADER,
  deadlineExceededException,
  remainingBeforeDeadline,
  whenCallerLeaves,
} from './deadline.js';

export { newTraceparent, parseTraceparent } from './traceparent.js';
export type { TraceContext } from './traceparent.js';

export {
  CollectionResponse,
  MemorisedResponse,
  PerishableResponse,
  SuccessEnvelopeInterceptor,
  markReplayed,
} from './success-envelope.interceptor.js';
export type { SuccessEnvelope } from './success-envelope.interceptor.js';

export { Endpoint, serveEndpoints, successSchemaOf } from './endpoint.js';
export type { EndpointDecorator } from './endpoint.js';

export {
  ENDPOINT_GUARDS,
  EndpointAccessGuard,
  EndpointGuardsCheck,
  EndpointRoute,
  routeOf,
  routePrincipalOf,
} from './endpoint-access.js';
export type { EndpointGuards, IdentityGuard, RuleGuard } from './endpoint-access.js';
export { EndpointInput, EndpointPrincipal } from './endpoint-input.js';
export { endpointProviders } from './endpoint-providers.js';
export type { EndpointGuardsBinding } from './endpoint-providers.js';
export { EndpointResponseInterceptor, SIGNED_IN_RIGHT } from './endpoint-response.interceptor.js';
export { REDACTED, redactSensitive } from './schema-paths.js';

export { contractSchemaConverter, mountDevDocs } from './dev-docs.js';
export type { DevDocsOptions } from './dev-docs.js';

export { AllowInProduction } from './allow-in-production.js';
export { HealthController, READINESS_CHECKS } from './health.controller.js';
export type { ReadinessCheck, ReadinessReport } from './health.controller.js';

export {
  IDEMPOTENCY_KEY_LIFETIME_HOURS,
  fingerprintOf,
  idempotencyKeyOf,
  idempotencyRecordTableDdl,
  idempotentRequestOf,
  keyedFingerprintOf,
  purgeIdempotencyRecords,
  runIdempotently,
  runIdempotentlyVersioned,
} from './idempotency.js';
export type { IdempotentRequest } from './idempotency.js';
