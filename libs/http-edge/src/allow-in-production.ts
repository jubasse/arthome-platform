import { Reflector, type ReflectableDecorator } from '@nestjs/core';

/**
 * Exempts a route or a controller from `DenyInProductionGuard`: the probes, and a route whose
 *   authorisation has landed. A route a slice has not authorised yet stays refused in production
 *   (the studio's until auth slice B): marking it reopens exactly what the guard closed.
 */
export const AllowInProduction: ReflectableDecorator<void, true> = Reflector.createDecorator<
  void,
  true
>({ transform: () => true });
