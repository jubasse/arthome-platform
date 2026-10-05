import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach } from 'vitest';
import { z } from 'zod';

import {
  errorCodesOf,
  versionedPath,
  type Api,
  type Response,
  type Route,
} from '@arthome/contracts/http';

/** `fail` makes an undeclared response fail its test; `report` lists them once per file. */
export type UndeclaredResponsesMode = 'report' | 'fail';

export interface UndeclaredResponse {
  readonly operationId: string;
  readonly status: number;
  /** The error envelope's code, null on a success or a body that carries none. */
  readonly code: string | null;
}

export interface DeclaredResponses {
  /** Before `app.init()`: Fastify takes no hook once it is ready. */
  readonly watch: (app: NestFastifyApplication) => void;
  readonly undeclared: readonly UndeclaredResponse[];
}

/** Failing, unless `ARTHOME_UNDECLARED_RESPONSES=report` asks for the list alone. */
export function undeclaredResponsesMode(): UndeclaredResponsesMode {
  return process.env.ARTHOME_UNDECLARED_RESPONSES === 'report' ? 'report' : 'fail';
}

/**
 * Every response of a watched app checked against its route's declaration (ADR contract model
 *   §7.3), the framework's refusals included: its status must be declared, and its error code too
 *   where the declared response names its codes. A response to no route of `api`, an unknown path
 *   or a route outside the contract, is not checked.
 */
export function declaredResponses(api: Api): DeclaredResponses {
  const routes = new Map(
    Object.values(api.routes).map((route) => [
      addressOf(route.method, versionedPath(route)),
      route,
    ]),
  );
  const undeclared: UndeclaredResponse[] = [];
  const payloads = new WeakMap<object, unknown>();
  return {
    undeclared,
    watch: (app) => {
      const fastify = app.getHttpAdapter().getInstance();
      fastify.addHook('onSend', async (request, _reply, payload) => {
        payloads.set(request, payload);
        return payload;
      });
      // The status once sent: another `onSend` hook may still change it, as a 304 does.
      fastify.addHook('onResponse', async (request, reply) => {
        const template = request.routeOptions.url;
        const route =
          template === undefined
            ? undefined
            : routes.get(addressOf(request.method, contractTemplateOf(template)));
        if (route === undefined) return;
        const finding = undeclaredResponseOf(route, reply.statusCode, payloads.get(request));
        if (finding !== null) undeclared.push(finding);
      });
    },
  };
}

/** `declaredResponses` with the suite's hooks: a test fails, or the file reports, by `mode`. */
export function guardDeclaredResponses(
  api: Api,
  mode: UndeclaredResponsesMode = undeclaredResponsesMode(),
): DeclaredResponses {
  const responses = declaredResponses(api);
  let seen = 0;
  afterEach(() => {
    const fresh = responses.undeclared.slice(seen);
    seen = responses.undeclared.length;
    if (mode === 'fail' && fresh.length > 0) {
      throw new Error(`Responses the contract does not declare:\n${linesOf(fresh)}`);
    }
  });
  afterAll(() => {
    if (mode === 'report' && responses.undeclared.length > 0) {
      console.warn(
        'Responses the contract does not declare (unset ARTHOME_UNDECLARED_RESPONSES=report to fail them):\n' +
          linesOf(responses.undeclared),
      );
    }
  });
  return responses;
}

function addressOf(method: string, template: string): string {
  return `${method.toUpperCase()} ${template}`;
}

function contractTemplateOf(routerPath: string): string {
  return routerPath.replace(/:([^/]+)/g, '{$1}');
}

function undeclaredResponseOf(
  route: Route,
  status: number,
  payload: unknown,
): UndeclaredResponse | null {
  const code = status >= 400 ? errorCodeOf(payload) : null;
  const declared = route.responses[String(status)];
  if (declared !== undefined) {
    const codes = errorCodesOf(route, status) ?? declaredCodesOf(declared);
    if (code === null || codes === null || codes.includes(code)) return null;
  }
  return { operationId: route.operationId, status, code };
}

function errorCodeOf(payload: unknown): string | null {
  if (typeof payload !== 'string') return null;
  try {
    const body: unknown = JSON.parse(payload);
    const code: unknown = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/**
 * The codes a hand-written response names, one envelope per code with a literal `error.code`; null
 *   when it does not name them. A route built with `errors` declares them through `errorCodesOf`.
 */
function declaredCodesOf(response: Response): readonly string[] | null {
  const schema = response.content?.['application/json']?.schema;
  return schema === undefined ? null : codesIn(schema);
}

function codesIn(schema: z.ZodType): string[] | null {
  if (schema instanceof z.ZodUnion) {
    const perOption = (schema.options as readonly z.ZodType[]).map(codesIn);
    return perOption.includes(null) ? null : perOption.flatMap((codes) => codes ?? []);
  }
  if (!(schema instanceof z.ZodObject)) return null;
  const error: unknown = schema.shape.error;
  if (!(error instanceof z.ZodObject)) return null;
  const code: unknown = error.shape.code;
  return code instanceof z.ZodLiteral ? [...code.values].map(String) : null;
}

function linesOf(findings: readonly UndeclaredResponse[]): string {
  const counts = new Map<string, number>();
  for (const { operationId, status, code } of findings) {
    const line = `${operationId} ${String(status)}${code === null ? '' : ` ${code}`}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts]
    .map(([line, count]) => `  ${line}${count > 1 ? ` (${String(count)} times)` : ''}`)
    .join('\n');
}
