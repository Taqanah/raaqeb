import { describe, expect, test } from "bun:test";
import {
  createMemo,
  entriesPerPage,
  etagOf,
  holdsEtag,
  isStorable,
  memoCap,
  type Validity,
} from "./memo.ts";

const url = "http://status.raaqeb.test/";
const day = Date.UTC(2026, 8, 26);
const at: Validity = { counter: 7, day };

function get(headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

/** A route's page: a 200 with Cache-Control public and a body. */
function page(body = "<html>overview</html>"): Response {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "content-type": "text/html; charset=utf-8",
    },
  });
}

/** A render that counts its calls and answers what `respond` makes. */
function counting(respond: () => Response = () => page()) {
  let calls = 0;
  return {
    calls: () => calls,
    render: () => {
      calls += 1;
      return Promise.resolve(respond());
    },
  };
}

describe("the memo", () => {
  test("two requests with no change between them cost one render, and the second holding the ETag gets a 304", async () => {
    const memo = createMemo(() => 10);
    const renders = counting();
    const first = await memo.respond(get(), "page ar /", at, renders.render);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("<html>overview</html>");
    const etag = first.headers.get("etag");
    expect(etag).toBe(
      etagOf(new TextEncoder().encode("<html>overview</html>"))
    );
    const second = await memo.respond(
      get({ "if-none-match": etag ?? "" }),
      "page ar /",
      at,
      renders.render
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
    expect(renders.calls()).toBe(1);
  });

  test("a stored entry answers a request without the ETag with the whole body, its type and the must-revalidate policy", async () => {
    const memo = createMemo(() => 10);
    const renders = counting();
    await memo.respond(get(), "k", at, renders.render);
    const again = await memo.respond(get(), "k", at, renders.render);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe("<html>overview</html>");
    expect(again.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(again.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate"
    );
    expect(renders.calls()).toBe(1);
  });

  test("a moved change counter renders the entry again", async () => {
    const memo = createMemo(() => 10);
    let body = "before";
    const renders = counting(() => page(body));
    await memo.respond(get(), "k", at, renders.render);
    body = "after";
    const moved = await memo.respond(
      get(),
      "k",
      { counter: 8, day },
      renders.render
    );
    expect(await moved.text()).toBe("after");
    expect(renders.calls()).toBe(2);
  });

  test("a new UTC day renders the entry again with the counter unchanged", async () => {
    const memo = createMemo(() => 10);
    const renders = counting();
    await memo.respond(get(), "k", at, renders.render);
    await memo.respond(
      get(),
      "k",
      { counter: 7, day: day + 86_400_000 },
      renders.render
    );
    expect(renders.calls()).toBe(2);
  });

  test("an ETag from before a change gets the new body, not a 304", async () => {
    const memo = createMemo(() => 10);
    let body = "before";
    const renders = counting(() => page(body));
    const first = await memo.respond(get(), "k", at, renders.render);
    body = "after";
    const next = await memo.respond(
      get({ "if-none-match": first.headers.get("etag") ?? "" }),
      "k",
      { counter: 8, day },
      renders.render
    );
    expect(next.status).toBe(200);
    expect(await next.text()).toBe("after");
  });

  test("a render with the same body after a change keeps its ETag, so a browser holding it still gets a 304", async () => {
    const memo = createMemo(() => 10);
    const renders = counting();
    const first = await memo.respond(get(), "k", at, renders.render);
    const next = await memo.respond(
      get({ "if-none-match": first.headers.get("etag") ?? "" }),
      "k",
      { counter: 8, day },
      renders.render
    );
    expect(next.status).toBe(304);
    expect(renders.calls()).toBe(2);
  });

  test("everyone asking while the entry renders awaits that one render", async () => {
    const memo = createMemo(() => 10);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const render = async () => {
      calls += 1;
      await gate;
      return page();
    };
    const waiting = [1, 2, 3, 4, 5].map(() =>
      memo.respond(get(), "k", at, render)
    );
    release();
    const answers = await Promise.all(waiting);
    expect(calls).toBe(1);
    const bodies = await Promise.all(answers.map((answer) => answer.text()));
    expect(new Set(bodies)).toEqual(new Set(["<html>overview</html>"]));
  });

  test("a render that may not be stored is answered as it came and rendered again next time", async () => {
    const memo = createMemo(() => 10);
    const renders = counting(() => new Response("Not Found", { status: 404 }));
    const first = await memo.respond(get(), "k", at, renders.render);
    expect(first.status).toBe(404);
    expect(await first.text()).toBe("Not Found");
    await memo.respond(get(), "k", at, renders.render);
    expect(renders.calls()).toBe(2);
    expect(memo.size()).toBe(0);
  });

  test("everyone waiting on a render that may not be stored gets an answer of their own", async () => {
    const memo = createMemo(() => 10);
    const renders = counting(() => new Response("Not Found", { status: 404 }));
    const answers = await Promise.all(
      [1, 2, 3].map(() => memo.respond(get(), "k", at, renders.render))
    );
    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404]);
    expect(await Promise.all(answers.map((answer) => answer.text()))).toEqual([
      "Not Found",
      "Not Found",
      "Not Found",
    ]);
  });

  test("a render that throws rejects everyone waiting on it and leaves nothing stored", async () => {
    const memo = createMemo(() => 10);
    const failing = () => Promise.reject(new Error("the database is gone"));
    await expect(memo.respond(get(), "k", at, failing)).rejects.toThrow(
      "the database is gone"
    );
    const renders = counting();
    await memo.respond(get(), "k", at, renders.render);
    expect(renders.calls()).toBe(1);
  });

  test("a HEAD is answered from the stored entry with its headers and no body", async () => {
    const memo = createMemo(() => 10);
    const renders = counting();
    await memo.respond(get(), "k", at, renders.render);
    const head = await memo.respond(
      new Request(url, { method: "HEAD" }),
      "k",
      at,
      renders.render
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe(
      etagOf(new TextEncoder().encode("<html>overview</html>"))
    );
    expect(renders.calls()).toBe(1);
  });

  test("past the cap the entry used longest ago goes first", async () => {
    const memo = createMemo(() => 2);
    const renders = counting();
    await memo.respond(get(), "a", at, renders.render);
    await memo.respond(get(), "b", at, renders.render);
    // Reading a keeps it; b is now the one used longest ago.
    await memo.respond(get(), "a", at, renders.render);
    await memo.respond(get(), "c", at, renders.render);
    expect(memo.size()).toBe(2);
    expect(renders.calls()).toBe(3);
    await memo.respond(get(), "a", at, renders.render);
    expect(renders.calls()).toBe(3);
    await memo.respond(get(), "b", at, renders.render);
    expect(renders.calls()).toBe(4);
  });

  test("a cap that shrinks is applied at the next store", async () => {
    let cap = 3;
    const memo = createMemo(() => cap);
    const renders = counting();
    for (const key of ["a", "b", "c"]) {
      // biome-ignore lint/performance/noAwaitInLoops: the order of stores is the test
      await memo.respond(get(), key, at, renders.render);
    }
    cap = 1;
    await memo.respond(get(), "d", at, renders.render);
    expect(memo.size()).toBe(1);
  });
});

/** Reads again until it answers `want`, at most two seconds: a refresh lands when its render settles, which no request waits on. */
async function until(read: () => Promise<string>, want: string) {
  const deadline = performance.now() + 2000;
  let got = await read();
  while (got !== want && performance.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: each read waits for the one before
    await Bun.sleep(2);
    got = await read();
  }
  return got;
}

describe("a stale entry", () => {
  const later: Validity = { counter: 8, day };
  /** A render that answers `body` once released, counting its calls and whether each refreshed a stale entry; with `held` false it answers at once. */
  function slow(body: string, held: boolean, init: ResponseInit = {}) {
    const refreshes: boolean[] = [];
    let release: () => void = () => undefined;
    const gate = held
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();
    return {
      refreshes,
      release: () => release(),
      render: async (refresh: boolean) => {
        refreshes.push(refresh);
        await gate;
        return new Response(body, {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "content-type": "text/html; charset=utf-8",
          },
          ...init,
        });
      },
    };
  }

  test("is answered once the wait is over when its refresh has not landed, and the refresh lands for the next request", async () => {
    const memo = createMemo(() => 10, isStorable, 5);
    await memo.respond(get(), "k", at, counting(() => page("before")).render);
    const refresh = slow("after", true);
    // The refresh is held until released, so an answer before that is the stale entry.
    const first = await memo.respond(get(), "k", later, refresh.render);
    expect(await first.text()).toBe("before");
    refresh.release();
    expect(
      await until(
        async () =>
          await (await memo.respond(get(), "k", later, refresh.render)).text(),
        "after"
      )
    ).toBe("after");
    expect(refresh.refreshes).toEqual([true]);
  });

  test("is rendered with the refresh flag, and a key the memo held nothing for without it, askers waiting on a render that was not stored included", async () => {
    const told: boolean[] = [];
    const render = (refresh: boolean) => {
      told.push(refresh);
      return Promise.resolve(page());
    };
    const memo = createMemo(() => 10);
    await memo.respond(get(), "k", at, render);
    await memo.respond(get(), "k", later, render);
    expect(told).toEqual([false, true]);
    const none: boolean[] = [];
    const unstored = (refresh: boolean) => {
      none.push(refresh);
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    };
    await Promise.all(
      [1, 2, 3].map(() => memo.respond(get(), "u", at, unstored))
    );
    expect(none).toEqual([false, false, false]);
  });

  test("is answered fresh when its refresh lands within the wait", async () => {
    const memo = createMemo(() => 10, isStorable, 60_000);
    await memo.respond(get(), "k", at, counting(() => page("before")).render);
    const refresh = slow("after", false);
    const fresh = await memo.respond(get(), "k", later, refresh.render);
    expect(await fresh.text()).toBe("after");
  });

  test("everyone asking it while it refreshes is answered from memory, and it refreshes once", async () => {
    const memo = createMemo(() => 10, isStorable, 5);
    await memo.respond(get(), "k", at, counting(() => page("before")).render);
    const refresh = slow("after", true);
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        memo.respond(get(), "k", later, refresh.render)
      )
    );
    const bodies = await Promise.all(answers.map((each) => each.text()));
    expect(new Set(bodies)).toEqual(new Set(["before"]));
    expect(refresh.refreshes).toEqual([true]);
    refresh.release();
  });

  test("a counter that moves again while it refreshes costs no second refresh, and the next change after it lands refreshes again", async () => {
    const memo = createMemo(() => 10, isStorable, 5);
    await memo.respond(get(), "k", at, counting(() => page("before")).render);
    const refresh = slow("after", true);
    const first = await memo.respond(get(), "k", later, refresh.render);
    const moved = await memo.respond(
      get(),
      "k",
      { counter: 9, day },
      refresh.render
    );
    expect([await first.text(), await moved.text()]).toEqual([
      "before",
      "before",
    ]);
    expect(refresh.refreshes).toEqual([true]);
    refresh.release();
    const newest = slow("newest", false);
    expect(
      await until(
        async () =>
          await (
            await memo.respond(get(), "k", { counter: 9, day }, newest.render)
          ).text(),
        "newest"
      )
    ).toBe("newest");
  });

  test("stays while a refresh is refused a turn, and goes once a refresh answers something no longer kept", async () => {
    const memo = createMemo(() => 10, isStorable, 200);
    await memo.respond(get(), "k", at, counting(() => page("before")).render);
    const refused = slow("busy", false, { status: 503 });
    const busy = await memo.respond(get(), "k", later, refused.render);
    expect(await busy.text()).toBe("before");
    const gone = slow("gone", false, { status: 404 });
    const answer = await memo.respond(get(), "k", later, gone.render);
    expect(answer.status).toBe(404);
    expect(memo.size()).toBe(0);
  });
});

describe("a memo that keeps not-founds", () => {
  const notFound = () =>
    new Response("<html>not found</html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 404,
    });
  const kept = (response: Response) => response.status === 404;

  test("answers the kept not-found with its status, rendered once", async () => {
    const memo = createMemo(() => 10, kept);
    const renders = counting(notFound);
    await memo.respond(get(), "missing", at, renders.render);
    const again = await memo.respond(get(), "missing", at, renders.render);
    expect(again.status).toBe(404);
    expect(await again.text()).toBe("<html>not found</html>");
    expect(renders.calls()).toBe(1);
  });

  test("never answers a not-found with a 304, which would tell a cache its copy is a page", async () => {
    const memo = createMemo(() => 10, kept);
    const renders = counting(notFound);
    const first = await memo.respond(get(), "missing", at, renders.render);
    const held = await memo.respond(
      get({ "if-none-match": first.headers.get("etag") ?? "*" }),
      "missing",
      at,
      renders.render
    );
    expect(held.status).toBe(404);
    expect(await held.text()).toBe("<html>not found</html>");
    expect(renders.calls()).toBe(1);
  });
});

describe("what the memo stores", () => {
  test("a 200 whose Cache-Control says public", () => {
    expect(isStorable(page())).toBe(true);
  });

  test("never a response without public, whatever else it says", () => {
    expect(isStorable(new Response("x"))).toBe(false);
    expect(
      isStorable(
        new Response("x", { headers: { "cache-control": "no-store" } })
      )
    ).toBe(false);
    expect(
      isStorable(
        new Response("x", {
          headers: { "cache-control": "private, max-age=0" },
        })
      )
    ).toBe(false);
  });

  test("never a status other than 200", () => {
    for (const status of [201, 204, 301, 304, 404, 500, 503]) {
      const response = new Response(
        status === 204 || status === 304 ? null : "x",
        {
          headers: { "cache-control": "public, max-age=0, must-revalidate" },
          status,
        }
      );
      expect(isStorable(response)).toBe(false);
    }
  });

  test("never a response that sets a cookie, which is one visitor's", () => {
    const response = page();
    response.headers.append("set-cookie", "session=abc");
    expect(isStorable(response)).toBe(false);
  });
});

describe("the ETag", () => {
  test("is the SHA-256 of the body cut to 128 bits, in hex, quoted as a strong tag", () => {
    const body = new TextEncoder().encode("hello");
    const full = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    expect(etagOf(body)).toBe(`"${full.slice(0, 32)}"`);
  });

  test("a request holds it when If-None-Match names it, weak, in a list or as *", () => {
    const etag = '"abc"';
    const asking = (value: string) => get({ "if-none-match": value });
    expect(holdsEtag(asking('"abc"'), etag)).toBe(true);
    expect(holdsEtag(asking('W/"abc"'), etag)).toBe(true);
    expect(holdsEtag(asking('"x", "abc"'), etag)).toBe(true);
    expect(holdsEtag(asking("*"), etag)).toBe(true);
    expect(holdsEtag(asking('"abd"'), etag)).toBe(false);
    expect(holdsEtag(get(), etag)).toBe(false);
  });
});

describe("the cap", () => {
  test("is pages times the entries a page may have, never under one page's worth", () => {
    expect(memoCap(3)).toBe(3 * entriesPerPage);
    expect(memoCap(1)).toBe(entriesPerPage);
    expect(memoCap(0)).toBe(entriesPerPage);
  });

  test("a page's entries are two locales of four views as HTML and as documents, the summary, and a feed and a badge in each locale", () => {
    expect(entriesPerPage).toBe(2 * 4 * 2 + 1 + 2 + 2);
  });
});

describe("edges of the memo", () => {
  test("a request after a change does not wait on the render from before it", async () => {
    const memo = createMemo(() => 10);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async () => {
      await gate;
      return page("before");
    };
    const waiting = memo.respond(get(), "k", at, slow);
    const renders = counting(() => page("after"));
    const fresh = await memo.respond(
      get(),
      "k",
      { counter: 8, day },
      renders.render
    );
    expect(await fresh.text()).toBe("after");
    release();
    expect(await (await waiting).text()).toBe("before");
  });

  test("the stored entry answers with its own length, not the stream's", async () => {
    const memo = createMemo(() => 10);
    const renders = counting(
      () =>
        new Response("<html>ok</html>", {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "transfer-encoding": "chunked",
          },
        })
    );
    await memo.respond(get(), "k", at, renders.render);
    const again = await memo.respond(get(), "k", at, renders.render);
    expect(again.headers.get("transfer-encoding")).toBeNull();
    expect(await again.text()).toBe("<html>ok</html>");
  });
});
