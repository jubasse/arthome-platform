import {
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
  type OnModuleInit,
} from '@nestjs/common';
import {
  DiscoveryService,
  MetadataScanner,
  Reflector,
  type ReflectableDecorator,
} from '@nestjs/core';

import type { Access, Requirement, Route } from '@arthome/contracts/http';

import { unauthenticated } from './principal.js';

/** The route a handler is bound to, set by `Endpoint`. */
export const EndpointRoute: ReflectableDecorator<Route> = Reflector.createDecorator<Route>();

export function routeOf(reflector: Reflector, context: ExecutionContext): Route | undefined {
  return reflector.get(EndpointRoute, context.getHandler());
}

/** Resolves the caller of an identity's routes, ADR contract model §4.5. */
export interface IdentityGuard {
  /** The principal, null when no credential was presented; a credential presented and refused throws. */
  identify(context: ExecutionContext, route: Route): Promise<unknown>;
  /** The headers every success of the identity's routes carries, read from the principal. */
  responseHeadersFor?(principal: unknown): Readonly<Record<string, string>>;
}

/** Enforces one rule of a route's `requires`, throwing the refusal its declaration names. */
export interface RuleGuard {
  check(context: ExecutionContext, rule: Requirement, principal: unknown): Promise<void>;
  /** Why this rule's parameters cannot be enforced (an unknown bucket), checked at boot. */
  problemWith?(rule: Requirement): string | undefined;
}

/** What each identity name and each rule name maps to, one table per process. */
export interface EndpointGuards {
  readonly identities: Readonly<Record<string, IdentityGuard>>;
  readonly rules: Readonly<Record<string, RuleGuard>>;
  /**
   * On a service, the operation ids that may be public: any other public route fails the boot.
   *   Absent on a BFF, whose public routes are its contract's to declare.
   */
  readonly publicAllowed?: readonly string[];
}

export const ENDPOINT_GUARDS: unique symbol = Symbol('EndpointGuards');

/** Boxed, so a public route's `undefined` principal is told apart from a request no guard saw. */
const principals = new WeakMap<object, { readonly principal: unknown }>();

/** The caller `EndpointAccessGuard` resolved: `undefined` on a public route, `null` for an anonymous one. */
export function routePrincipalOf(request: object): unknown {
  const held = principals.get(request);
  if (held === undefined) throw new Error('No principal: the route declares no access.');
  return held.principal;
}

function guardFor<G>(table: Readonly<Record<string, G>>, name: string): G {
  const guard = table[name];
  if (guard === undefined) throw new Error(`No guard is bound for "${name}".`);
  return guard;
}

/**
 * Applies a route's access, identity first, then each rule in its declared order, which may read the
 *   principal. A route bound without `access` is left to the legacy guards until its module opts in.
 */
@Injectable()
export class EndpointAccessGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    @Inject(ENDPOINT_GUARDS) private readonly guards: EndpointGuards,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = routeOf(this.reflector, context);
    if (route?.access === undefined) return true;

    const principal =
      route.access.kind === 'identified'
        ? await this.principalFor(context, route, route.access)
        : undefined;
    principals.set(context.switchToHttp().getRequest<object>(), { principal });

    for (const rule of route.requires ?? []) {
      await guardFor(this.guards.rules, rule.name).check(context, rule, principal);
    }
    return true;
  }

  private async principalFor(
    context: ExecutionContext,
    route: Route,
    access: Extract<Access, { readonly kind: 'identified' }>,
  ): Promise<unknown> {
    const found = await guardFor(this.guards.identities, access.identity.name).identify(
      context,
      route,
    );
    if (found === null) {
      if (access.optional) return null;
      throw unauthenticated();
    }
    // Stripped to what the identity declares, so a handler never reads a field the contract does not name.
    return access.identity.principal.parse(found);
  }
}

/**
 * Fails the boot on a route whose identity or rule has no guard, a rule its guard cannot enforce,
 *   or a public route on a service outside its allow-list, so nothing passes by omission (ADR
 *   contract model §4.3), and lists the bound routes still without `access`.
 */
@Injectable()
export class EndpointGuardsCheck implements OnModuleInit {
  private readonly logger = new Logger('Endpoint access');

  public constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    @Inject(ENDPOINT_GUARDS) private readonly guards: EndpointGuards,
  ) {}

  public onModuleInit(): void {
    const routes = this.boundRoutes();
    const unguarded = routes.flatMap((route) => this.unguardedNamesOf(route));
    if (unguarded.length > 0) {
      throw new Error(`Routes whose access cannot be enforced: ${unguarded.join(', ')}.`);
    }
    const legacy = routes.filter((route) => route.access === undefined);
    if (legacy.length > 0) {
      this.logger.warn(
        `Bound without access, under the legacy guards: ${legacy.map((route) => route.operationId).join(', ')}.`,
      );
    }
  }

  private boundRoutes(): Route[] {
    return this.discovery.getControllers().flatMap((wrapper) => {
      const prototype = (wrapper.metatype as { prototype?: object } | null)?.prototype ?? null;
      if (prototype === null) return [];
      return this.scanner.getAllMethodNames(prototype).flatMap((name) => {
        const route = this.reflector.get(
          EndpointRoute,
          (prototype as Record<string, () => unknown>)[name] as () => unknown,
        );
        return route === undefined ? [] : [route];
      });
    });
  }

  private unguardedNamesOf(route: Route): string[] {
    const { publicAllowed } = this.guards;
    const exposed =
      route.access?.kind === 'anyone' &&
      publicAllowed !== undefined &&
      !publicAllowed.includes(route.operationId)
        ? [`${route.operationId} (public on a service)`]
        : [];
    const identity =
      route.access?.kind === 'identified' &&
      this.guards.identities[route.access.identity.name] === undefined
        ? [`${route.operationId} (identity ${route.access.identity.name})`]
        : [];
    const rules = (route.requires ?? []).flatMap((rule) => {
      const guard = this.guards.rules[rule.name];
      if (guard === undefined) return [`${route.operationId} (rule ${rule.name})`];
      const problem = guard.problemWith?.(rule);
      return problem === undefined ? [] : [`${route.operationId} (rule ${rule.name}: ${problem})`];
    });
    return [...exposed, ...identity, ...rules];
  }
}
