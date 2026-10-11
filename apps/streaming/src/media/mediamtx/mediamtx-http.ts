export const MEDIAMTX_CALL_TIMEOUT_MS = 3_000;

/**
 * Names the server and the operation only: a URL, a body or a cause can hold a stream path, a
 *   recording reference or a token (R15).
 */
export class MediaMtxCallFailed extends Error {
  public override readonly name = 'MediaMtxCallFailed';

  public constructor(server: string, operation: string, outcome: string) {
    super(`${server}: ${operation} ${outcome}`);
  }
}

export interface MediaMtxRequest {
  /** A fixed label for errors, never the path. */
  readonly operation: string;
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** One MediaMTX listener (Control API, metrics, playback server), every call bounded. */
export class MediaMtxHttp {
  public constructor(
    private readonly server: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number = MEDIAMTX_CALL_TIMEOUT_MS,
  ) {}

  /** Null on a 404: absence is an answer the callers branch on. */
  public async json<T>(request: MediaMtxRequest): Promise<T | null> {
    const response = await this.send(request);
    if (response === null) return null;
    try {
      return (await response.json()) as T;
    } catch {
      throw new MediaMtxCallFailed(this.server, request.operation, 'answered no JSON');
    }
  }

  public async text(request: MediaMtxRequest): Promise<string | null> {
    const response = await this.send(request);
    if (response === null) return null;
    try {
      return await response.text();
    } catch {
      throw new MediaMtxCallFailed(this.server, request.operation, 'answered no body');
    }
  }

  /** True when the call took effect, false on a 404. */
  public async command(request: MediaMtxRequest): Promise<boolean> {
    const response = await this.send(request);
    if (response === null) return false;
    await response.body?.cancel();
    return true;
  }

  private async send({ operation, method = 'GET', path, query, body }: MediaMtxRequest) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body !== undefined && {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      throw new MediaMtxCallFailed(
        this.server,
        operation,
        timedOut ? `got no answer within ${String(this.timeoutMs)} ms` : 'was unreachable',
      );
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaMtxCallFailed(this.server, operation, `answered ${String(response.status)}`);
    }
    return response;
  }
}
