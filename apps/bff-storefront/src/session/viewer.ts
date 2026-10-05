import type { PresentedSession } from './session-carriers.js';
import type { ResolvedViewer } from '../identity/identity-answers.schema.js';
import type { Caller } from '../internal-token.minter.js';

/** The signed-in viewer a request carries, as identity resolved its session. */
export interface Viewer extends ResolvedViewer, PresentedSession {}

const viewers = new WeakMap<object, Viewer>();

export function attachViewer(request: object, viewer: Viewer): void {
  viewers.set(request, viewer);
}

export function callerOf(viewer: Viewer): Caller {
  return { accountId: viewer.accountId, deviceId: viewer.deviceId };
}

/** The viewer `ViewerIdentity` left on the request, if the route resolved one. */
export function viewerOf(request: object): Viewer | null {
  return viewers.get(request) ?? null;
}
