import fastifyCookie from '@fastify/cookie';
import fastifyCsrfProtection from '@fastify/csrf-protection';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import {
  CSRF_HEADER,
  CSRF_SECRET_ATTRIBUTES,
  CSRF_SECRET_COOKIE,
  SESSION_COOKIE,
  type CookieCarrier,
} from './session-carriers.js';

export const CSRF_SECRET: unique symbol = Symbol('CsrfSecret');

interface PluginHost {
  register(plugin: unknown, options?: unknown): unknown;
}

/**
 * Registers the cookie and CSRF plugins on the Fastify instance while the module graph starts, so
 *   any application built from `AppModule`, `main.ts`'s or a suite's, has them. The CSRF token is
 *   bound to the session cookie (`getUserInfo`): a token minted for one session is refused for
 *   another.
 */
@Injectable()
export class EdgePlugins implements OnModuleInit {
  public constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(CSRF_SECRET) private readonly csrfSecret: string,
  ) {}

  public onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter?.getInstance<PluginHost>();
    if (fastify === undefined) return;
    fastify.register(fastifyCookie);
    fastify.register(fastifyCsrfProtection, {
      cookieKey: CSRF_SECRET_COOKIE,
      cookieOpts: CSRF_SECRET_ATTRIBUTES,
      getToken: (request: CookieCarrier) => {
        const token = request.headers[CSRF_HEADER];
        return typeof token === 'string' ? token : undefined;
      },
      getUserInfo: (request: CookieCarrier) => request.cookies?.[SESSION_COOKIE] ?? '',
      csrfOpts: { hmacKey: this.csrfSecret },
    });
  }
}
