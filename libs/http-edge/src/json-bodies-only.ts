import { Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

interface ContentTypeParsers {
  removeContentTypeParser(contentTypes: readonly string[]): void;
}

/**
 * Leaves JSON the only body a route parses (transport.md §5.7), so any other answers 415. Fastify
 *   parses `text/plain` and Nest `application/x-www-form-urlencoded` by default: a form-encoded
 *   sign-in reached identity before this. Removed at module init, after Nest has registered its
 *   parsers and before Fastify starts, which refuses the change once started.
 * A default: a route needing another body, auth slice B's `form_post` callback, will add its parser
 *   in its own Fastify scope. JSON with its raw bytes, the payment webhook's, is untouched.
 */
@Injectable()
export class JsonBodiesOnly implements OnModuleInit {
  public constructor(private readonly adapterHost: HttpAdapterHost) {}

  public onModuleInit(): void {
    this.adapterHost.httpAdapter
      ?.getInstance<ContentTypeParsers>()
      .removeContentTypeParser(['text/plain', 'application/x-www-form-urlencoded']);
  }
}
