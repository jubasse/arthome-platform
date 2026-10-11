import { HealthController, READINESS_CHECKS } from '@arthome-platform/http-edge';
import { Module, type FactoryProvider, type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants.js';

import { AppModule } from '../app.module.js';

/** Read off `AppModule` itself, so a drill asks the readiness the API serves, not a copy of it. */
function apiReadinessChecks(): FactoryProvider {
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) as Provider[];
  const checks = providers.find(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' &&
      'provide' in provider &&
      provider.provide === READINESS_CHECKS,
  );
  if (checks === undefined) throw new Error('AppModule binds no READINESS_CHECKS');
  return checks;
}

/** The API's `/health/readiness`, beside the feature modules a drill boots. */
@Module({ controllers: [HealthController], providers: [apiReadinessChecks()] })
export class ApiReadinessModule {}
