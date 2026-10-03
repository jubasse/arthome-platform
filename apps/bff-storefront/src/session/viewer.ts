import { unauthenticated } from '@arthome-platform/http-edge';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { Reflector, type ReflectableDecorator } from '@nestjs/core';

import type { PresentedSession } from './session-carriers.js';
import type { ResolvedSession } from '../identity/identity-answers.schema.js';
import type { Caller } from '../internal-token.minter.js';

/** The signed-in viewer a request carries, as identity resolved its session. */
export interface Viewer extends ResolvedSession, PresentedSession {}

const viewers = new WeakMap<object, Viewer>();

export function attachViewer(request: object, viewer: Viewer): void {
  viewers.set(request, viewer);
}

/** Marks a route that serves a signed-in viewer alone: `ViewerGuard` resolves the session first. */
export const RequiresViewer: ReflectableDecorator<void, true> = Reflector.createDecorator<
  void,
  true
>({ transform: () => true });

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
