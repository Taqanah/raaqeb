import { afterEach, describe, expect, test } from "bun:test";
import { requestOriginHeader } from "@/server/boot/proxies.ts";
import {
  type PagesScratch,
  publish,
  scratchPages,
  testAddress,
} from "@/server/pages/fixture.ts";
import { createPage, savePage } from "@/server/pages/pages.ts";
import type { PublicTarget } from "@/server/pages/public.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { createPublicMemo } from "./public.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const now = Date.UTC(2026, 8, 26, 12);

async function withDefaultPage(
  published = true
): Promise<{ pageId: string; s: PagesScratch }> {
  scratch = await scratchPages(now);
  const created = await createPage(scratch.storage, {
    locale: "ar",
    slug: "main",
    title: "Main",
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  if (published) {
    await publish(scratch.storage, created.page.id);
  }
  return { pageId: created.page.id, s: scratch };
}

/** The operator check the entry hands the memo, answering `signedIn` and counting its calls. */
function operator(signedIn: boolean) {
  let calls = 0;
  return {
    calls: () => calls,
    check: () => {
      calls += 1;
      return Promise.resolve(signedIn);
    },
  };
}

/** A request as the entry hands it on: the origin it resolved in Raaqeb's header. */
function request(
  path: string,
  init: { headers?: Record<string, string>; method?: string } = {}
): Request {
  return new Request(`http://status.raaqeb.test${path}`, {
    headers: {
      [requestOriginHeader]: "http://status.raaqeb.test",
      ...init.headers,
    },
    method: init.method ?? "GET",
  });
}

/** The route's render: counts its calls, records each target, answers a public page. */
function renders() {
  const targets: PublicTarget[] = [];
  return {
    render: (target: PublicTarget) => {
      targets.push(target);
      return Promise.resolve(
        new Response(`page ${targets.length}`, {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "content-type": "text/html; charset=utf-8",
          },
        })
      );
    },
    targets,
  };
}

describe("the memo in front of the public page", () => {
  test("two requests with no change between them cost one render and one 304", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    const first = await memo.answer(request("/"), s.storage, route.render);
    expect(first?.status).toBe(200);
    const etag = first?.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const second = await memo.answer(
      request("/", { headers: { "if-none-match": etag } }),
      s.storage,
      route.render
    );
    expect(second?.status).toBe(304);
    expect(route.targets).toHaveLength(1);
  });

  test("the route renders with the page and locale the request resolved to", async () => {
    const { pageId, s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    await memo.answer(request("/en"), s.storage, route.render);
    expect(route.targets).toMatchObject([
      { kind: "view", locale: "en", pageId, view: "overview" },
    ]);
  });

  test("a write that moves the change counter renders the page again", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    await memo.answer(request("/"), s.storage, route.render);
    await s.storage.bump();
    const again = await memo.answer(request("/"), s.storage, route.render);
    expect(await again?.text()).toBe("page 2");
  });

  test("the next UTC day renders the page again with the counter unchanged", async () => {
    const { s } = await withDefaultPage();
    let clock = now;
    const memo = createPublicMemo({ now: () => clock });
    const route = renders();
    await memo.answer(request("/"), s.storage, route.render);
    clock = now + 86_400_000;
    await memo.answer(request("/"), s.storage, route.render);
    expect(route.targets).toHaveLength(2);
  });

  test("a page's new slug is read at the next request, since its save moved the counter", async () => {
    const { pageId, s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    expect(
      await memo.answer(request("/status/renamed"), s.storage, route.render)
    ).toBeUndefined();
    const saved = await savePage(s.storage, pageId, {
      customDomain: undefined,
      customization: (await s.storage.pages.find(pageId))?.customization ?? {
        ...(await import("@/shared/schemas/page.ts")).defaultCustomization,
      },
      isDefault: true,
      published: true,
      layout: [],
      locale: "ar",
      slug: "renamed",
      title: { ar: "Main" },
    });
    expect(saved.ok).toBe(true);
    const answer = await memo.answer(
      request("/status/renamed"),
      s.storage,
      route.render
    );
    expect(answer?.status).toBe(200);
  });

  test("the overview's document is memoised once for both locales", async () => {
    const { pageId, s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    await memo.answer(
      request(`/api/pages/${pageId}/overview`),
      s.storage,
      route.render
    );
    await memo.answer(
      request(`/api/pages/${pageId}/overview`),
      s.storage,
      route.render
    );
    expect(route.targets).toEqual([
      {
        key: `${pageId} document /overview`,
        kind: "document",
        pageId,
        published: true,
        view: "overview",
      },
    ]);
  });

  test("a request that shows no view is not the memo's", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    for (const path of ["/admin/monitors", "/sign-in", "/status/nope", "/ar"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time, as a visitor sends them
      expect(await memo.answer(request(path), s.storage, route.render)).toBe(
        undefined
      );
    }
    expect(route.targets).toHaveLength(0);
  });

  test("only a GET or a HEAD is the memo's", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    expect(
      await memo.answer(
        request("/", { method: "POST" }),
        s.storage,
        route.render
      )
    ).toBeUndefined();
    const head = await memo.answer(
      request("/", { method: "HEAD" }),
      s.storage,
      route.render
    );
    expect(head?.status).toBe(200);
  });

  test("with no database open nothing is the memo's", async () => {
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    expect(
      await memo.answer(request("/"), undefined, route.render)
    ).toBeUndefined();
  });

  test("a change counter that cannot be read renders the page fresh from the pages last read, never a stale entry and never the admin", async () => {
    const { pageId, s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    await memo.answer(request("/"), s.storage, route.render);
    const broken = {
      ...s.storage,
      changeCounter: () => Promise.reject(new Error("gone")),
    };
    const fresh = await memo.answer(request("/"), broken, route.render);
    expect(await fresh?.text()).toBe("page 2");
    await memo.answer(request("/"), broken, route.render);
    expect(route.targets).toHaveLength(3);
    expect(route.targets.at(-1)).toMatchObject({ kind: "view", pageId });
  });

  test("a change counter that cannot be read before any page was known hands the request on", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    const broken = {
      ...s.storage,
      changeCounter: () => Promise.reject(new Error("gone")),
    };
    expect(
      await memo.answer(request("/"), broken, route.render)
    ).toBeUndefined();
  });

  test("a custom domain resolves through the origin the entry resolved behind the trusted proxies", async () => {
    const { pageId, s } = await withDefaultPage();
    const saved = await savePage(s.storage, pageId, {
      customDomain: "status.shop.test",
      customization: (await import("@/shared/schemas/page.ts"))
        .defaultCustomization,
      isDefault: false,
      published: true,
      layout: [],
      locale: "ar",
      slug: "main",
      title: { ar: "Main" },
    });
    expect(saved.ok).toBe(true);
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    const answer = await memo.answer(
      new Request("http://status.shop.test/", {
        headers: { [requestOriginHeader]: "https://status.shop.test" },
      }),
      s.storage,
      route.render
    );
    expect(answer?.status).toBe(200);
    expect(route.targets).toMatchObject([{ kind: "view", pageId }]);
    // The Host header alone never picks a page the entry did not resolve.
    expect(
      await memo.answer(
        new Request("http://status.shop.test/"),
        s.storage,
        route.render
      )
    ).toBeUndefined();
  });
});

describe("the page that frames a not-found, from the memo's pages index", () => {
  /** The storage with every read counted. */
  function counted(storage: PagesScratch["storage"]) {
    let reads = 0;
    const count =
      <A extends unknown[], R>(read: (...args: A) => R) =>
      (...args: A): R => {
        reads += 1;
        return read(...args);
      };
    return {
      reads: () => reads,
      storage: {
        changeCounter: count(() => storage.changeCounter()),
        pages: { ...storage.pages, list: count(() => storage.pages.list()) },
        settings: {
          ...storage.settings,
          get: count(storage.settings.get.bind(storage.settings)),
        },
      },
    };
  }

  test("an unknown address is framed by the default page the last answer indexed, with no read of its own", async () => {
    const { pageId, s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    const watched = counted(s.storage);
    for (const path of ["/wp-login.php", "/status/nope"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one address at a time, as the entry asks
      const answer = await memo.answer(
        request(path),
        watched.storage,
        route.render
      );
      expect(answer).toBeUndefined();
      const before = watched.reads();
      expect(memo.missing(request(path)), path).toEqual({
        locale: "ar",
        pageId,
        paths: { bases: { ar: "", en: "/en" }, origin: testAddress },
      });
      expect(watched.reads(), path).toBe(before);
    }
    expect(route.targets).toEqual([]);
  });

  test("with no page indexed, or before any answer, nothing frames it", async () => {
    scratch = await scratchPages(now);
    const memo = createPublicMemo({ now: () => now });
    expect(memo.missing(request("/status/missing"))).toBeUndefined();
    await memo.answer(
      request("/status/missing"),
      scratch.storage,
      renders().render
    );
    expect(memo.missing(request("/status/missing"))).toBeUndefined();
  });
});

describe("the summary, badge and feed in the memo", () => {
  test("each costs one render and then a 304 while nothing changes, and a write renders it again", async () => {
    const { pageId, s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    for (const path of [
      "/api/v2/summary.json",
      "/badge.svg",
      "/en/feed.atom",
    ]) {
      const route = renders();
      // biome-ignore lint/performance/noAwaitInLoops: one address at a time
      const first = await memo.answer(request(path), s.storage, route.render);
      expect(first?.status, path).toBe(200);
      const second = await memo.answer(
        request(path, {
          headers: { "if-none-match": first?.headers.get("etag") ?? "" },
        }),
        s.storage,
        route.render
      );
      expect(second?.status, path).toBe(304);
      expect(route.targets, path).toMatchObject([{ kind: "resource", pageId }]);
      await s.storage.bump();
      await memo.answer(request(path), s.storage, route.render);
      expect(route.targets, path).toHaveLength(2);
    }
  });
});

describe("the public address the memo read", () => {
  test("is none before any answer, the stored one after, and the new one once the counter moves", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    expect(memo.publicAddress()).toBe(undefined);
    await memo.answer(request("/"), s.storage, renders().render);
    expect(memo.publicAddress()).toBe(testAddress);
    await s.storage.settings.set(publicAddress, "http://status.raaqeb.test");
    await s.storage.bump();
    await memo.answer(request("/"), s.storage, renders().render);
    expect(memo.publicAddress()).toBe("http://status.raaqeb.test");
  });
});

describe("the change counter read once per request", () => {
  test("the counter the entry read before resolving the client address is the one the answer judges by, with no read of its own", async () => {
    const { pageId, s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    let reads = 0;
    const watched = {
      ...s.storage,
      changeCounter: () => {
        reads += 1;
        return s.storage.changeCounter();
      },
    };
    const route = renders();
    const counter = memo.read(watched);
    expect(await counter).toBe(await s.storage.changeCounter());
    const first = await memo.answer(
      request("/"),
      watched,
      route.render,
      counter
    );
    expect(await first?.text()).toBe("page 1");
    expect(route.targets).toMatchObject([{ kind: "view", pageId }]);
    expect(reads).toBe(1);
  });

  test("a read the entry made after the counter moved indexes the pages again before the answer", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    await memo.answer(request("/"), s.storage, renders().render);
    await s.storage.settings.set(publicAddress, "http://status.raaqeb.test");
    await s.storage.bump();
    await memo.read(s.storage);
    expect(memo.publicAddress()).toBe("http://status.raaqeb.test");
  });

  test("a counter the entry could not read renders the page fresh, as one the answer could not read", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    await memo.answer(request("/"), s.storage, route.render);
    const broken = {
      ...s.storage,
      changeCounter: () => Promise.reject(new Error("gone")),
    };
    const counter = memo.read(broken);
    expect(await counter).toBe(undefined);
    await memo.answer(request("/"), s.storage, route.render, counter);
    expect(route.targets).toHaveLength(2);
  });
});

describe("an unpublished page in front of the memo", () => {
  /** Every view and document address of the default page. */
  const viewAddresses = (pageId: string) => [
    "/",
    "/en",
    "/history",
    "/status/main",
    `/api/pages/${pageId}/overview`,
    `/api/pages/${pageId}/history`,
  ];

  test("a visitor finds nothing at its views and documents: the memo answers none and renders none", async () => {
    const { pageId, s } = await withDefaultPage(false);
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    for (const path of viewAddresses(pageId)) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time, as a visitor sends them
      const answer = await memo.answer(request(path), s.storage, route.render);
      expect(answer, path).toBeUndefined();
    }
    expect(route.targets).toEqual([]);
  });

  test("a request without the operator's session finds nothing either", async () => {
    const { pageId, s } = await withDefaultPage(false);
    const visitor = operator(false);
    const memo = createPublicMemo({ now: () => now, operator: visitor.check });
    const route = renders();
    for (const path of viewAddresses(pageId)) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time, as a visitor sends them
      const answer = await memo.answer(request(path), s.storage, route.render);
      expect(answer, path).toBeUndefined();
    }
    expect(route.targets).toEqual([]);
  });

  test("the signed-in operator sees its views and documents as a preview, rendered fresh on every request, never stored and never cached", async () => {
    const { pageId, s } = await withDefaultPage(false);
    const signedIn = operator(true);
    const memo = createPublicMemo({ now: () => now, operator: signedIn.check });
    const route = renders();
    for (const path of viewAddresses(pageId)) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time, as a browser sends them
      const answer = await memo.answer(request(path), s.storage, route.render);
      expect(answer?.status, path).toBe(200);
      expect(answer?.headers.get("cache-control"), path).toBe("no-store");
      expect(answer?.headers.get("etag"), path).toBeNull();
    }
    const again = await memo.answer(request("/"), s.storage, route.render);
    expect(await again?.text()).toBe(
      `page ${viewAddresses(pageId).length + 1}`
    );
    expect(memo.size()).toBe(0);
    expect(route.targets.every((target) => !target.published)).toBe(true);
  });

  test("its badge, feed and summary are found by no one, the signed-in operator included", async () => {
    const { s } = await withDefaultPage(false);
    const signedIn = operator(true);
    const memo = createPublicMemo({ now: () => now, operator: signedIn.check });
    const route = renders();
    for (const path of ["/badge.svg", "/feed.atom", "/api/v2/summary.json"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.answer(request(path), s.storage, route.render);
      expect(answer, path).toBeUndefined();
    }
    expect(route.targets).toEqual([]);
  });

  test("a published page costs no session read", async () => {
    const { s } = await withDefaultPage();
    const signedIn = operator(true);
    const memo = createPublicMemo({ now: () => now, operator: signedIn.check });
    await memo.answer(request("/"), s.storage, renders().render);
    expect(signedIn.calls()).toBe(0);
  });

  test("once unpublished, the entry the memo stored is served to no visitor again; published again, the page is public", async () => {
    const { pageId, s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    expect(
      (await memo.answer(request("/"), s.storage, route.render))?.status
    ).toBe(200);
    const page = await s.storage.pages.find(pageId);
    if (!page) {
      throw new Error("the page is gone");
    }
    await savePage(s.storage, pageId, {
      ...page,
      layout: [],
      published: false,
    });
    expect(await memo.answer(request("/"), s.storage, route.render)).toBe(
      undefined
    );
    await publish(s.storage, pageId);
    expect(
      (await memo.answer(request("/"), s.storage, route.render))?.status
    ).toBe(200);
  });

  test("its addresses are unpublished ones, the bare host included where it is the default; any other address is not", async () => {
    const { s } = await withDefaultPage(false);
    const memo = createPublicMemo({ now: () => now });
    for (const path of ["/", "/en", "/status/nope", "/admin/monitors"]) {
      // biome-ignore lint/performance/noAwaitInLoops: the index is read by the first answer
      await memo.answer(request(path), s.storage, renders().render);
    }
    for (const path of ["/", "/en", "/status/main/history", "/badge.svg"]) {
      expect(memo.unpublished(request(path)), path).toBe(true);
    }
    for (const path of ["/status/nope", "/admin/monitors", "/sign-in"]) {
      expect(memo.unpublished(request(path)), path).toBe(false);
    }
  });

  test("an unpublished page frames no not-found: with it the default, an unknown address has no frame", async () => {
    const { s } = await withDefaultPage(false);
    const memo = createPublicMemo({ now: () => now });
    await memo.answer(request("/status/nope"), s.storage, renders().render);
    expect(memo.missing(request("/status/nope"))).toBeUndefined();
    expect(memo.missing(request("/"))).toBeUndefined();
  });
});
