import { Reflector, type ReflectableDecorator } from '@nestjs/core';

/**
 * Exempts a route or a controller from `DenyInProductionGuard`.
 *
 * For the probes only. The guard exists because every write route here ships reachable; an
 *   exemption on one of those reopens exactly what it closed.
 */
export const AllowInProduction: ReflectableDecorator<void, true> = Reflector.createDecorator<
  void,
  true
>({ transform: () => true });
