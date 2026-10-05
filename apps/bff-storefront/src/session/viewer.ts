import { unauthenticated } from '@arthome-platform/http-edge';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { Reflector, type ReflectableDecorator } from '@nestjs/core';

import type { PresentedSession } from './session-carriers.js';
import type { ResolvedViewer } from '../identity/identity-answers.schema.js';
import type { Caller } from '../internal-token.minter.js';

/** The signed-in viewer a request carries, as identity resolved its session. */
export interface Viewer extends ResolvedViewer, PresentedSession {}

const viewers = new WeakMap<object, Viewer>();

export function attachViewer(request: object, viewer: Viewer): void {
  viewers.set(request, viewer);
}

/**
 * Marks a route that serves a signed-in viewer alone: `ViewerGuard` resolves the session first; only the auth controller still marks one.
 * @deprecated A route declared with the `viewer` identity is resolved by `ViewerIdentity`.
 */
export const RequiresViewer: ReflectableDecorator<void, true> = Reflector.createDecorator<
  void,
  true
>({ transform: () => true });

/** @deprecated `EndpointInput` or `EndpointPrincipal` hands the principal of a route with an access. */
export const CurrentViewer: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Viewer => {
    const viewer = viewers.get(context.switchToHttp().getRequest<object>());
    if (viewer === undefined) throw unauthenticated();
    return viewer;
  },
);

export function callerOf(viewer: Viewer): Caller {
  return { accountId: viewer.accountId, deviceId: viewer.deviceId };
}

/** The viewer `ViewerGuard` left on the request, if the route asked for one. */
export function viewerOf(request: object): Viewer | null {
  return viewers.get(request) ?? null;
}
