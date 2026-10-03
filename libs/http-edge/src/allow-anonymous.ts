import { Reflector, type ReflectableDecorator } from '@nestjs/core';

/**
 * Exempts a route or a controller from the internal token's guard: the probes, and a provider's
 *   webhook, which its own signature authenticates. Never a route a BFF calls: the BFF mints a
 *   token for an anonymous visitor too, so "public" is not a reason.
 */
export const AllowAnonymous: ReflectableDecorator<void, true> = Reflector.createDecorator<
  void,
  true
>({ transform: () => true });
