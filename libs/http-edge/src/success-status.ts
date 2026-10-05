import type { RouteShape } from '@arthome/contracts/http';

/** The 2xx statuses a route declares, lowest first. */
export function successStatusesOf(route: RouteShape): number[] {
  return Object.keys(route.responses)
    .map(Number)
    .filter((status) => status >= 200 && status < 300)
    .sort((a, b) => a - b);
}

/** By request: the status a handler chose among its route's several, which `serveEndpoints`' hook sends. */
const answeredStatuses = new WeakMap<object, number>();

export function answerWithStatus(request: object, status: number): void {
  answeredStatuses.set(request, status);
}

export function answeredStatusOf(request: object): number | undefined {
  return answeredStatuses.get(request);
}
