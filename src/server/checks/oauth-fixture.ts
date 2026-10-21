/**
 * Test support: a fake OAuth 2.0 token endpoint on a free loopback port that
 * records each request and answers as its owner says, and a fake API that
 * records the Authorization it was called with. Not product code.
 */

export interface TokenCall {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly path: string;
}

export interface TokenAnswer {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}

export interface FakeTokenServer {
  /** What the next requests are answered with; each call takes the next, the last repeats. */
  answers: TokenAnswer[];
  /** Every request, in order. */
  readonly calls: TokenCall[];
  readonly stop: () => void;
  readonly url: string;
}

/** A token as the endpoint writes it. */
export function tokenJson(
  token: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    access_token: token,
    expires_in: 3600,
    token_type: "Bearer",
    ...extra,
  });
}

export function startTokenServer(answers: TokenAnswer[]): FakeTokenServer {
  const calls: TokenCall[] = [];
  const state = { answers, served: 0 };
  const server = Bun.serve({
    fetch: async (request) => {
      calls.push({
        body: await request.text(),
        headers: Object.fromEntries(request.headers),
        method: request.method,
        path: new URL(request.url).pathname,
      });
      const list = state.answers;
      const answer = list[Math.min(state.served, list.length - 1)] ?? {};
      state.served += 1;
      return new Response(answer.body ?? tokenJson("token-1"), {
        headers: {
          "content-type": "application/json",
          ...answer.headers,
        },
        status: answer.status ?? 200,
      });
    },
    port: 0,
  });
  return {
    calls,
    get answers() {
      return state.answers;
    },
    set answers(next) {
      state.answers = next;
    },
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}/token`,
  };
}

export interface FakeApi {
  /** The Authorization of each request, none as an empty string. */
  readonly authorizations: string[];
  readonly stop: () => void;
  readonly url: string;
}

/** An API that answers `status` (200 by default) and, when `echo` is on, writes the Authorization it was called with into its body. */
export function startApi(
  options: { body?: string; echo?: boolean; status?: () => number } = {}
): FakeApi {
  const authorizations: string[] = [];
  const server = Bun.serve({
    fetch: (request) => {
      const authorization = request.headers.get("authorization") ?? "";
      authorizations.push(authorization);
      return new Response(
        options.body ?? (options.echo ? `you sent ${authorization}` : "ok"),
        { status: options.status?.() ?? 200 }
      );
    },
    port: 0,
  });
  return {
    authorizations,
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}/`,
  };
}
