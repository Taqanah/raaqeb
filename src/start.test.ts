import { describe, expect, mock, test } from "bun:test";
import type { CustomFetch } from "@tanstack/react-start";
import { buildHeader, reloadingFetch, reloadOnce } from "./start.ts";

/** sessionStorage's two calls over a Map, which outlives a reload as the tab's own does. */
function tabStorage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

/** A server answering every server function call with the status given and the build it names, or none. */
function serverOf(build: string | undefined, status: number) {
  return () =>
    Promise.resolve(
      new Response("{}", {
        headers: build === undefined ? {} : { [buildHeader]: build },
        status,
      })
    );
}

/** What the caller gets within a few milliseconds: the answer, or nothing while the page reloads. */
async function settled(answer: Promise<Response>): Promise<Response | "held"> {
  return await Promise.race([
    answer,
    Bun.sleep(20).then(() => "held" as const),
  ]);
}

describe("an answer from a server function", () => {
  test("that failed on this tab's build reaches the caller and reloads nothing", async () => {
    const reload = mock(() => undefined);
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      reload,
      serverOf("b1", 500)
    );
    const answer = await settled(call("/_serverFn/x"));
    expect(answer).toBeInstanceOf(Response);
    expect(reload).toHaveBeenCalledTimes(0);
  });

  test("that failed naming no build reaches the caller and reloads nothing", async () => {
    const reload = mock(() => undefined);
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      reload,
      serverOf(undefined, 500)
    );
    const answer = await settled(call("/_serverFn/x"));
    expect(answer).toBeInstanceOf(Response);
    expect(reload).toHaveBeenCalledTimes(0);
  });

  test("that failed naming no build after a reload for another build reaches the caller", async () => {
    const storage = tabStorage();
    const reload = mock(() => undefined);
    const first = reloadingFetch("b1", storage, reload, serverOf("b2", 500));
    await settled(first("/_serverFn/x"));
    const unnamed = reloadingFetch(
      "b1",
      storage,
      reload,
      serverOf(undefined, 500)
    );
    expect(await settled(unnamed("/_serverFn/x"))).toBeInstanceOf(Response);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("that succeeded on another build reaches the caller unchanged and reloads nothing, so a save is never lost", async () => {
    const reload = mock(() => undefined);
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      reload,
      serverOf("b2", 200)
    );
    const answer = await settled(call("/_serverFn/x"));
    expect(answer).toBeInstanceOf(Response);
    expect(answer instanceof Response && answer.status).toBe(200);
    expect(reload).toHaveBeenCalledTimes(0);
  });

  test("that failed on another build reloads the page and is held from the caller", async () => {
    const reload = mock(() => undefined);
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      reload,
      serverOf("b2", 500)
    );
    expect(await settled(call("/_serverFn/x"))).toBe("held");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("that failed on another build after a reload for that build reaches the caller, so the tab never loops", async () => {
    const storage = tabStorage();
    const reload = mock(() => undefined);
    // The reload brought back the old build, as a cache still serving it would.
    const first = reloadingFetch("b1", storage, reload, serverOf("b2", 500));
    await settled(first("/_serverFn/x"));
    const afterReload = reloadingFetch(
      "b1",
      storage,
      reload,
      serverOf("b2", 500)
    );
    const answer = await settled(afterReload("/_serverFn/x"));
    expect(answer).toBeInstanceOf(Response);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("that failed on a later deploy reloads again, though the reload for the deploy before brought back the old build", async () => {
    const storage = tabStorage();
    const reload = mock(() => undefined);
    const first = reloadingFetch("b1", storage, reload, serverOf("b2", 500));
    await settled(first("/_serverFn/x"));
    const later = reloadingFetch("b1", storage, reload, serverOf("b3", 500));
    expect(await settled(later("/_serverFn/x"))).toBe("held");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test("that failed on another build reloads a tab whose chunk reload went to a network blip on its own build", async () => {
    const storage = tabStorage();
    const reload = mock(() => undefined);
    expect(reloadOnce("b1", storage)).toBe(true);
    const call = reloadingFetch("b1", storage, reload, serverOf("b2", 500));
    expect(await settled(call("/_serverFn/x"))).toBe("held");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("that failed in a tab with no build of its own, as under the source tree, reaches the caller", async () => {
    const reload = mock(() => undefined);
    const call = reloadingFetch(
      undefined,
      tabStorage(),
      reload,
      serverOf("b2", 500)
    );
    const answer = await settled(call("/_serverFn/x"));
    expect(answer).toBeInstanceOf(Response);
    expect(reload).toHaveBeenCalledTimes(0);
  });
});

/** A failed answer from a proxy in front of a server that is restarting: no build named. */
function proxyFailed(): Response {
  return new Response("Bad Gateway", { status: 502 });
}

/** An answer from the server running `build`, with `status`. */
function answered(build: string, status: number): Response {
  return new Response("{}", { headers: { [buildHeader]: build }, status });
}

/**
 * A server whose attempts go as listed: "down" is a connection that fails,
 * as during a restart; the last entry answers every attempt after it. It
 * counts the attempts and records each wait between them.
 */
function restarting(...attempts: (Response | "down")[]) {
  const record = { pauses: [] as number[], tries: 0 };
  const base: CustomFetch = () => {
    const attempt = attempts[Math.min(record.tries, attempts.length - 1)];
    record.tries += 1;
    return attempt === undefined || attempt === "down"
      ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve(attempt.clone());
  };
  const wait = (ms: number) => {
    record.pauses.push(ms);
    return Promise.resolve();
  };
  return { base, record, wait };
}

const read = { method: "GET" } as const;
const write = { method: "POST" } as const;

describe("a read from a server function that reached no server", () => {
  test("is tried again after 1, 2, 4 and 8 seconds and reaches the caller once the server answers", async () => {
    const server = restarting(
      "down",
      "down",
      "down",
      "down",
      answered("b1", 200)
    );
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    const answer = await call("/_serverFn/x", read);
    expect(answer.status).toBe(200);
    expect(server.record.tries).toBe(5);
    expect(server.record.pauses).toEqual([1000, 2000, 4000, 8000]);
  });

  test("that failed naming no build is tried again, as a proxy answers for a server that is restarting", async () => {
    const server = restarting(proxyFailed(), answered("b1", 200));
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    expect((await call("/_serverFn/x", read)).status).toBe(200);
    expect(server.record.tries).toBe(2);
    expect(server.record.pauses).toEqual([1000]);
  });

  test("still reaching none after about 30 seconds hands the failed connection to the caller", async () => {
    const server = restarting("down");
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    await expect(call("/_serverFn/x", read)).rejects.toThrow("Failed to fetch");
    expect(server.record.tries).toBe(6);
    expect(server.record.pauses).toEqual([1000, 2000, 4000, 8000, 15_000]);
  });

  test("still failing naming no build after about 30 seconds hands that answer to the caller", async () => {
    const server = restarting(proxyFailed());
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    expect((await call("/_serverFn/x", read)).status).toBe(502);
    expect(server.record.tries).toBe(6);
  });

  test("that reaches the new build failing reloads the page, as after any other deploy", async () => {
    const reload = mock(() => undefined);
    const server = restarting("down", answered("b2", 500));
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      reload,
      server.base,
      server.wait
    );
    expect(await settled(call("/_serverFn/x", read))).toBe("held");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("answered successfully naming no build reaches the caller at once", async () => {
    const server = restarting(new Response("{}", { status: 200 }));
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    expect((await call("/_serverFn/x", read)).status).toBe(200);
    expect(server.record.tries).toBe(1);
  });

  test("that failed on this tab's build is not tried again: the server answered", async () => {
    const server = restarting(answered("b1", 500), answered("b1", 200));
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    expect((await call("/_serverFn/x", read)).status).toBe(500);
    expect(server.record.tries).toBe(1);
  });

  test("the caller abandoned is not tried again", async () => {
    const server = restarting("down", answered("b1", 200));
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    const left = new AbortController();
    left.abort();
    await expect(
      call("/_serverFn/x", { ...read, signal: left.signal })
    ).rejects.toThrow("Failed to fetch");
    expect(server.record.tries).toBe(1);
  });

  test("whose caller leaves during a wait is handed back at once, not after the wait", async () => {
    const server = restarting("down");
    // The tab's own wait, 1 second before the first retry.
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base
    );
    const left = new AbortController();
    const answer = call("/_serverFn/x", { ...read, signal: left.signal }).then(
      () => "answered",
      () => "handed back"
    );
    await Bun.sleep(10);
    left.abort();
    expect(
      await Promise.race([answer, Bun.sleep(300).then(() => "waiting")])
    ).toBe("handed back");
    expect(server.record.tries).toBe(1);
  });

  test("that failed naming no build after its caller left is not tried again", async () => {
    const server = restarting(proxyFailed(), answered("b1", 200));
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    const left = new AbortController();
    left.abort();
    await expect(
      call("/_serverFn/x", { ...read, signal: left.signal })
    ).rejects.toThrow();
    expect(server.record.tries).toBe(1);
    expect(server.record.pauses).toEqual([]);
  });

  test("in a tab with no build of its own, as under the source tree, is not tried again", async () => {
    const server = restarting("down", answered("b1", 200));
    const call = reloadingFetch(
      undefined,
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    await expect(call("/_serverFn/x", read)).rejects.toThrow("Failed to fetch");
    expect(server.record.tries).toBe(1);
  });
});

describe("a write from a server function that reached no server", () => {
  test("is never tried again, so no save applies twice", async () => {
    const server = restarting("down", answered("b1", 200));
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    await expect(call("/_serverFn/x", write)).rejects.toThrow(
      "Failed to fetch"
    );
    expect(server.record.tries).toBe(1);
  });

  test("that failed naming no build is never tried again", async () => {
    const server = restarting(proxyFailed(), answered("b1", 200));
    const call = reloadingFetch(
      "b1",
      tabStorage(),
      mock(() => undefined),
      server.base,
      server.wait
    );
    expect((await call("/_serverFn/x", write)).status).toBe(502);
    expect(server.record.tries).toBe(1);
  });
});

describe("a reload for a chunk that failed to load", () => {
  test("happens once per build of the tab", () => {
    const storage = tabStorage();
    expect(reloadOnce("b1", storage)).toBe(true);
    expect(reloadOnce("b1", storage)).toBe(false);
  });

  test("happens again in the next build, as after a second deploy", () => {
    const storage = tabStorage();
    expect(reloadOnce("b1", storage)).toBe(true);
    expect(reloadOnce("b2", storage)).toBe(true);
    expect(reloadOnce("b2", storage)).toBe(false);
  });

  test("happens in a tab that reloaded for the server's build and now runs it", async () => {
    const storage = tabStorage();
    const call = reloadingFetch(
      "b1",
      storage,
      mock(() => undefined),
      serverOf("b2", 500)
    );
    await settled(call("/_serverFn/x"));
    expect(reloadOnce("b2", storage)).toBe(true);
  });

  test("never happens in a tab with no build of its own", () => {
    expect(reloadOnce(undefined, tabStorage())).toBe(false);
  });
});
