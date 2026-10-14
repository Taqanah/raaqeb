import {
  type CustomFetch,
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { error as logError, loggedPath, reasonOf } from "@/server/log.ts";

// A custom createStart() drops Start's default CSRF middleware, so it is
// re-added here for server functions and pinned by e2e/csrf.spec.ts.
const csrf = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

// h3 writes an error that escapes the handler as a multi-line stack with the
// install's paths; caught here, it is one line and the same
// 500 body h3 answers. First, so it covers the CSRF check too.
const escaped = createMiddleware().server(async ({ next, request }) => {
  try {
    return await next();
  } catch (thrown) {
    // A client that left gets no answer and no line; Start ends the request with the signal's reason.
    if (request.signal.aborted) {
      throw thrown;
    }
    const message = thrown instanceof Error ? reasonOf(thrown) : String(thrown);
    logError(
      `the request ${request.method} ${loggedPath(request.url)} failed: ${message}`
    );
    return Response.json(
      { message: "HTTPError", status: 500, unhandled: true },
      { status: 500 }
    );
  }
});

/** Whether a server function call carries a payload that is not JSON: Start parses it before any handler, and logs the failure as a stack trace with the install's paths. */
export async function malformedPayload(request: Request): Promise<boolean> {
  try {
    if (request.method === "GET") {
      const payload = new URL(request.url).searchParams.get("payload");
      if (payload) {
        JSON.parse(payload);
      }
    } else if (
      request.headers.get("content-type")?.includes("application/json")
    ) {
      // ponytail: the body is parsed twice, here and by Start; payloads are small forms, capped at 8 MB by the entry.
      await request.clone().json();
    }
    return false;
  } catch {
    return true;
  }
}

// After the CSRF check, so a forged call is still a 403; a call whose payload is not JSON is a plain 400 before Start logs it as a stack trace.
const refused = createMiddleware().server(
  async ({ handlerType, next, request }) => {
    if (handlerType === "serverFn" && (await malformedPayload(request))) {
      return new Response("Bad Request", { status: 400 });
    }
    return await next();
  }
);

// This build's id, which vite.config.ts makes new on every build; a run from the source tree has none.
declare const __RAAQEB_BUILD__: string | undefined;
const build =
  typeof __RAAQEB_BUILD__ === "string" ? __RAAQEB_BUILD__ : undefined;

/** The header naming the server's build on every server function's answer. */
export const buildHeader = "x-raaqeb-build";

/** Where a tab remembers the server's build it last reloaded for. */
const reloadedFor = "raaqeb:reloaded-for";

/** Where a tab remembers its own build it last reloaded away from after a failed chunk. */
const chunkReloadedFrom = "raaqeb:chunk-reloaded-from";

/** True once per build under `key`, so a build that still fails after the reload cannot loop the tab. */
function once(
  key: string,
  id: string,
  storage: Pick<Storage, "getItem" | "setItem">
): boolean {
  if (storage.getItem(key) === id) {
    return false;
  }
  storage.setItem(key, id);
  return true;
}

/**
 * Whether a tab running the build `own` reloads after a chunk failed to load:
 * once per build of the tab, since the failure does not say which build the
 * server runs, and a network failure looks the same.
 */
export function reloadOnce(
  own: string | undefined,
  storage: Pick<Storage, "getItem" | "setItem">
): boolean {
  return own !== undefined && once(chunkReloadedFrom, own, storage);
}

/** The waits before each retry of a read that reached no server: about 30 seconds in all, a deploy's restart. */
const retryPausesMs = [1000, 2000, 4000, 8000, 15_000];

/** Waits `ms` milliseconds on the tab's own clock, or rejects at once when `signal` fires. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/**
 * The server functions' fetch: an answer that failed on another build reloads
 * the page once per server build instead of reaching the caller, whose
 * function id or chunks that build may no longer have. A successful
 * answer always reaches the caller: function ids hold across builds, so an
 * old tab's save may succeed, and reloading would lose it.
 *
 * A read (GET) that reached no server, a failed connection or a failed answer
 * naming no build, as from a proxy in front of a restarting server, is tried
 * again after each of the pauses, then handed to the caller. A write
 * is never tried again, so no save applies twice, nor is a read whose caller
 * left: a route loader hands in its abort signal, which the router fires
 * when a later load replaces it. A tab with no build of its own cannot tell
 * the server's failure from a proxy's, so it never retries.
 */
export function reloadingFetch(
  own: string | undefined,
  storage: Pick<Storage, "getItem" | "setItem">,
  reload: () => void,
  base: CustomFetch = fetch,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = pause
): CustomFetch {
  const judged = async (response: Response): Promise<Response> => {
    const sent = response.headers.get(buildHeader);
    if (
      response.ok ||
      own === undefined ||
      sent === null ||
      sent === own ||
      !once(reloadedFor, sent, storage)
    ) {
      return response;
    }
    reload();
    // The page is going away; the caller never renders the other build's answer.
    return await new Promise<never>(() => undefined);
  };
  return async (input, init) => {
    const pauses =
      own !== undefined && init?.method === "GET" ? retryPausesMs : [];
    for (const ms of pauses) {
      // biome-ignore lint/performance/noAwaitInLoops: each attempt waits for the one before it
      const response = await base(input, init).catch((thrown: unknown) => {
        // A caller that left, as a superseded load does, wants no answer and no retry.
        if (init?.signal?.aborted) {
          throw thrown;
        }
        return null;
      });
      if (response && (response.ok || response.headers.has(buildHeader))) {
        return await judged(response);
      }
      // Nor after a failed answer.
      init?.signal?.throwIfAborted();
      await wait(ms, init?.signal ?? undefined);
    }
    return await judged(await base(input, init));
  };
}

// First, so the 500 escaped answers for a function id this build lacks names the build too.
const stamped = createMiddleware().server(async ({ handlerType, next }) => {
  const result = await next();
  if (handlerType === "serverFn" && build !== undefined) {
    result.response.headers.set(buildHeader, build);
  }
  return result;
});

// Read on use, never on load: a browser that blocks storage throws on the read.
const tabStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
};

// A route chunk this build no longer serves fails its import, which Vite's preload helper announces.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", () => {
    if (reloadOnce(build, tabStorage)) {
      window.location.reload();
    }
  });
}

export const startInstance = createStart(() => ({
  requestMiddleware: [stamped, escaped, csrf, refused],
  serverFns: {
    fetch: reloadingFetch(build, tabStorage, () => window.location.reload()),
  },
}));
