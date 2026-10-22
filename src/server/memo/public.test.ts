import { afterEach, describe, expect, test } from "bun:test";
import { requestOriginHeader } from "@/server/boot/proxies.ts";
import { createIncident } from "@/server/incidents/incidents.ts";
import { createComponent } from "@/server/pages/components.ts";
import {
  type PagesScratch,
  publish,
  scratchPages,
  testAddress,
} from "@/server/pages/fixture.ts";
import { createPage, savePage } from "@/server/pages/pages.ts";
import type { PublicTarget, ViewTarget } from "@/server/pages/public.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { publicAccess } from "@/shared/schemas/page.ts";
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
        access: publicAccess,
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

  test("a change counter that cannot be read renders the page fresh after its access is read again from storage, never a stale entry and never the admin", async () => {
    const { pageId, s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    await memo.answer(request("/"), s.storage, route.render);
    let found = 0;
    const broken = {
      ...s.storage,
      changeCounter: () => Promise.reject(new Error("gone")),
      pages: {
        ...s.storage.pages,
        find: (id: string) => {
          found += 1;
          return s.storage.pages.find(id);
        },
      },
    };
    const fresh = await memo.answer(request("/"), broken, route.render);
    expect(await fresh?.text()).toBe("page 2");
    expect(found).toBe(1);
    await memo.answer(request("/"), broken, route.render);
    expect(route.targets).toHaveLength(3);
    expect(route.targets.at(-1)).toMatchObject({ kind: "view", pageId });
    // The pages last read say public; storage says private now: storage wins.
    const page = await s.storage.pages.find(pageId);
    if (!page) {
      throw new Error("no page");
    }
    await s.storage.pages.save(
      pageId,
      { ...page, access: { addresses: [], mode: "signed_in" } },
      []
    );
    const closed = await memo.answer(request("/"), broken, route.render);
    expect(closed?.status).toBe(403);
    expect(route.targets).toHaveLength(3);
  });

  test("a change counter and a page that cannot be read answer as a private page without access, never the page", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    await memo.answer(request("/"), s.storage, route.render);
    const broken = {
      ...s.storage,
      changeCounter: () => Promise.reject(new Error("gone")),
      pages: {
        ...s.storage.pages,
        find: () => Promise.reject(new Error("gone")),
      },
    };
    const [stored] = await s.storage.pages.list();
    for (const path of [
      "/",
      `/api/pages/${stored?.id}/overview`,
      "/badge.svg",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.answer(request(path), broken, route.render);
      expect(answer?.status, path).toBe(403);
      expect(answer?.headers.get("cache-control"), path).toBe(
        "private, no-store"
      );
    }
    expect(route.targets).toHaveLength(1);
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
        components: storage.components,
        incidents: storage.incidents,
        maintenance: storage.maintenance,
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

/** The app's render of a not-found: records the address and target it was asked for, answers a framed not-found with its language switch. */
function missingRenders() {
  const asked: { path: string; target: ViewTarget | undefined }[] = [];
  return {
    asked,
    render: (address: Request, target: ViewTarget | undefined) => {
      asked.push({ path: new URL(address.url).pathname, target });
      return Promise.resolve(
        new Response(
          `<html><head><script>theme()</script></head><body><main data-slot="view-missing">not found ${asked.length}</main><a data-slot="page-locale" href="/en">English</a><script type="module" src="/assets/index.js"></script></body></html>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
            status: 404,
          }
        )
      );
    },
  };
}

describe("the not-found the memo answers", () => {
  test("every address that names no page is the one still document, rendered once at the address its frame renders at", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    const bodies: string[] = [];
    for (const path of ["/.env", "/wp-admin/setup.php", "/status/nope"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time, as a scanner sends them
      const answer = await memo.notFound(request(path), s.storage, app.render);
      expect(answer?.status, path).toBe(404);
      bodies.push((await answer?.text()) ?? "");
    }
    expect(app.asked).toEqual([
      { path: "/history/0000-00", target: undefined },
    ]);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("not found 1");
    expect(bodies[0]).toContain("<script>theme()</script>");
    expect(bodies[0]).not.toContain('type="module"');
  });

  test("an address under a locale's prefix is that locale's own document, kept apart from the unprefixed one and rendered under the prefix", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    for (const path of ["/nope", "/en/nope", "/en/.env", "/wp-admin"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time, as a scanner sends them
      await memo.notFound(request(path), s.storage, app.render);
    }
    expect(app.asked.map((each) => each.path)).toEqual([
      "/history/0000-00",
      "/en/history/0000-00",
    ]);
  });

  test("with no page to frame it, a prefixed address is still rendered under its prefix", async () => {
    scratch = await scratchPages(now);
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    for (const path of ["/nope", "/en/nope", "/en/.env"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      await memo.notFound(request(path), scratch.storage, app.render);
    }
    expect(app.asked.map((each) => each.path)).toEqual([
      "/history/0000-00",
      "/en/history/0000-00",
    ]);
  });

  test("a page's slug frames the not-found under its address, rendered under that address, apart from the default page's", async () => {
    const { s } = await withDefaultPage();
    const docs = await createPage(s.storage, {
      locale: "ar",
      slug: "docs",
      title: "Docs",
    });
    if (!docs.ok) {
      throw new Error(docs.reason);
    }
    await publish(s.storage, docs.page.id);
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    await memo.notFound(request("/status/docs/nope"), s.storage, app.render);
    await memo.notFound(request("/status/main/nope"), s.storage, app.render);
    expect(app.asked.map((each) => each.path)).toEqual([
      "/status/docs/history/0000-00",
      "/history/0000-00",
    ]);
  });

  test("a moved change counter, or the next UTC day, renders the not-found again", async () => {
    const { s } = await withDefaultPage();
    let clock = now;
    const memo = createPublicMemo({ now: () => clock });
    const app = missingRenders();
    await memo.notFound(request("/.env"), s.storage, app.render);
    await s.storage.bump();
    await memo.notFound(request("/.env"), s.storage, app.render);
    clock = now + 86_400_000;
    await memo.notFound(request("/.env"), s.storage, app.render);
    expect(app.asked).toHaveLength(3);
  });

  test("with no database open, as in onboarding, it is still rendered once", async () => {
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    for (const path of ["/.env", "/.git/config"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.notFound(request(path), undefined, app.render);
      expect(answer?.status, path).toBe(404);
    }
    expect(app.asked).toHaveLength(1);
  });

  test("an address under /api/ with no route is the API's own not-found, plain text, and renders nothing", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    for (const method of ["GET", "POST"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.notFound(
        request("/api/nope", { method }),
        s.storage,
        app.render
      );
      expect(answer?.status, method).toBe(404);
      expect(answer?.headers.get("content-type"), method).toBe(
        "text/plain; charset=utf-8"
      );
      expect(await answer?.text(), method).toBe("Not Found");
    }
    expect(app.asked).toEqual([]);
  });

  test("an address the app's own route answers is not the memo's", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    for (const path of [
      "/",
      "/sign-in",
      "/admin/nope",
      "/health",
      "/api/auth/get-session",
      "/_serverFn/x",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.notFound(request(path), s.storage, app.render);
      expect(answer, path).toBeUndefined();
    }
    expect(app.asked).toEqual([]);
  });

  test("the bare host of an unpublished default page is a visitor's not-found too", async () => {
    const { s } = await withDefaultPage(false);
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    await memo.answer(request("/"), s.storage, renders().render);
    const answer = await memo.notFound(request("/"), s.storage, app.render);
    expect(answer?.status).toBe(404);
  });

  test("an app route's address that is gone is the plain not-found, rendered once at its own address without the search, whatever page the host shows", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    const gone = (pathname: string) =>
      Promise.resolve(pathname.startsWith("/onboarding"));
    for (const path of ["/onboarding?locale=en", "/onboarding/account"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.notFound(
        request(path),
        s.storage,
        app.render,
        undefined,
        gone
      );
      expect(answer?.status, path).toBe(404);
    }
    expect(app.asked).toEqual([{ path: "/onboarding", target: undefined }]);
    expect(
      await memo.notFound(
        request("/sign-in"),
        s.storage,
        app.render,
        undefined,
        gone
      )
    ).toBeUndefined();
  });

  test("a HEAD gets the not-found's status and headers with no body", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    const answer = await memo.notFound(
      request("/.env", { method: "HEAD" }),
      s.storage,
      app.render
    );
    expect(answer?.status).toBe(404);
    expect(answer?.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(await answer?.text()).toBe("");
  });
});

describe("an incident, window or month a page does not have", () => {
  /** The default page showing one component, with one incident on it. */
  async function withIncident(): Promise<{
    incidentId: string;
    s: PagesScratch;
  }> {
    const { pageId, s } = await withDefaultPage();
    const component = await createComponent(s.storage, {
      description: undefined,
      monitorIds: [],
      name: { ar: "الموقع" },
      status: "operational",
    });
    if (!component.ok) {
      throw new Error(component.reason);
    }
    const page = await s.storage.pages.find(pageId);
    if (!page) {
      throw new Error("no page");
    }
    await s.storage.pages.save(pageId, page, [
      { componentId: component.component.id, kind: "component" },
    ]);
    const incident = await createIncident(
      s.storage,
      {
        impact: "minor",
        message: { ar: "بطء" },
        stage: "investigating",
        statuses: [
          {
            componentId: component.component.id,
            status: "degraded_performance",
          },
        ],
        title: { ar: "بطء" },
      },
      "operator@raaqeb.test"
    );
    if (!incident.ok) {
      throw new Error(incident.reason);
    }
    await s.storage.bump();
    return { incidentId: incident.incident.id, s };
  }

  test("is its page's not-found in the address's locale, rendered once for every such address, never the view", async () => {
    const { s } = await withIncident();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    const app = missingRenders();
    for (const path of [
      "/incidents/nope",
      "/maintenance/nope",
      "/history/2000-01",
      "/incidents/again",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.answer(
        request(path),
        s.storage,
        route.render,
        undefined,
        app.render
      );
      expect(answer?.status, path).toBe(404);
    }
    expect(route.targets).toEqual([]);
    expect(app.asked).toHaveLength(1);
    expect(app.asked[0]?.target).toMatchObject({
      locale: "ar",
      view: "incident",
    });
    const english = await memo.answer(
      request("/en/incidents/nope"),
      s.storage,
      route.render,
      undefined,
      app.render
    );
    expect(english?.status).toBe(404);
    expect(app.asked).toHaveLength(2);
    expect(app.asked[1]?.target).toMatchObject({ locale: "en" });
  });

  test("its language switch keeps the address, in the other locale", async () => {
    const { s } = await withIncident();
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    for (const [path, other] of [
      ["/incidents/nope", "/en/incidents/nope"],
      ["/maintenance/again", "/en/maintenance/again"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.answer(
        request(path),
        s.storage,
        renders().render,
        undefined,
        app.render
      );
      expect(await answer?.text(), path).toContain(
        `<a data-slot="page-locale" href="${other}">`
      );
    }
  });

  test("an incident the page has, this month and the months every page shows render their views, as before", async () => {
    const { incidentId, s } = await withIncident();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    const app = missingRenders();
    for (const path of [
      `/incidents/${incidentId}`,
      "/history/2026-09",
      "/history/2026-07",
      "/history",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.answer(
        request(path),
        s.storage,
        route.render,
        undefined,
        app.render
      );
      expect(answer?.status, path).toBe(200);
    }
    expect(route.targets).toHaveLength(4);
    expect(app.asked).toEqual([]);
  });

  test("a month after this one is not on the page, and an id with a malformed escape is left to the view", async () => {
    const { s } = await withIncident();
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    const app = missingRenders();
    const future = await memo.answer(
      request("/history/2026-10"),
      s.storage,
      route.render,
      undefined,
      app.render
    );
    expect(future?.status).toBe(404);
    await memo.answer(
      request("/incidents/%E0"),
      s.storage,
      route.render,
      undefined,
      app.render
    );
    expect(route.targets).toMatchObject([{ view: "incident" }]);
  });

  test("fifty months before its history cost one read of the page's history while the counter holds, and a write reads it again", async () => {
    const { s } = await withIncident();
    let reads = 0;
    const counted = {
      ...s.storage,
      incidents: {
        ...s.storage.incidents,
        list: () => {
          reads += 1;
          return s.storage.incidents.list();
        },
      },
    };
    const memo = createPublicMemo({ now: () => now });
    const route = renders();
    const app = missingRenders();
    const ask = (path: string) =>
      memo.answer(request(path), counted, route.render, undefined, app.render);
    for (let i = 0; i < 50; i += 1) {
      const month = `${2010 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      expect((await ask(`/history/${month}`))?.status, month).toBe(404);
    }
    expect(reads).toBe(1);
    expect(route.targets).toEqual([]);
    await s.storage.bump();
    await ask("/history/2009-01");
    expect(reads).toBe(2);
  });

  test("a counter that cannot be read renders the not-found fresh and keeps none", async () => {
    const { s } = await withIncident();
    const memo = createPublicMemo({ now: () => now });
    const app = missingRenders();
    const broken = {
      ...s.storage,
      changeCounter: () => Promise.reject(new Error("gone")),
    };
    for (const path of ["/.env", "/.env"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.notFound(request(path), broken, app.render);
      expect(answer?.status).toBe(404);
    }
    expect(app.asked).toHaveLength(2);
  });
});

/** The app's render of a page: counts its calls, answers a 200 document, with a cookie or another status when told. */
function pageRenders(answer: () => ResponseInit = () => ({})) {
  let calls = 0;
  const asked: Request[] = [];
  return {
    asked,
    calls: () => calls,
    render: (address?: Request) => {
      calls += 1;
      if (address) {
        asked.push(address);
      }
      return Promise.resolve(
        new Response(`page ${calls}`, {
          headers: { "content-type": "text/html; charset=utf-8" },
          ...answer(),
        })
      );
    },
  };
}

describe("a page everyone without a session gets the same, in the memo", () => {
  test("costs one render per locale however often, through whatever host and with whatever cookie it is asked", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = pageRenders();
    const ask = (path: string, headers: Record<string, string> = {}) =>
      memo.anonymous(request(path, { headers }), s.storage, app.render);
    for (const path of ["/sign-in", "/sign-in", "/sign-in?locale=en"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      expect((await ask(path))?.status, path).toBe(200);
    }
    expect(await (await ask("/sign-in"))?.text()).toBe("page 1");
    for (const origin of ["https://a.example", "https://b.example"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      await ask("/sign-in", { [requestOriginHeader]: origin });
    }
    await ask("/sign-in", { cookie: "raaqeb.session_token=stale" });
    expect(app.calls()).toBe(2);
  });

  test("is rendered at its path and search alone: no cookie and no origin shape the page every visitor gets", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = pageRenders();
    await memo.anonymous(
      request("/sign-in?locale=en", {
        headers: { cookie: "raaqeb.session_token=x" },
      }),
      s.storage,
      app.render
    );
    const [address] = app.asked;
    expect(new URL(address?.url ?? "").pathname).toBe("/sign-in");
    expect(new URL(address?.url ?? "").search).toBe("?locale=en");
    expect([...(address?.headers.keys() ?? [])]).toEqual([]);
  });

  test("another search, another page or another method is not the memo's", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = pageRenders();
    for (const asked of [
      request("/sign-in?x=1"),
      request("/reset-password?token=abc"),
      request("/admin/monitors"),
      request("/sign-in", { method: "POST" }),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.anonymous(asked, s.storage, app.render);
      expect(answer, asked.url).toBeUndefined();
    }
    expect(app.calls()).toBe(0);
  });

  test("a render that is no 200, or that sets a cookie, is answered as it came and kept by no one", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    for (const init of [
      { status: 307 },
      { headers: { "set-cookie": "a=b" } },
    ]) {
      const app = pageRenders(() => init);
      // biome-ignore lint/performance/noAwaitInLoops: one case at a time
      await memo.anonymous(request("/sign-in"), s.storage, app.render);
      await memo.anonymous(request("/sign-in"), s.storage, app.render);
      expect(app.calls()).toBe(2);
    }
  });

  test("a moved change counter renders it again, and with no database open it is still rendered once", async () => {
    const { s } = await withDefaultPage();
    const memo = createPublicMemo({ now: () => now });
    const app = pageRenders();
    await memo.anonymous(request("/sign-in"), s.storage, app.render);
    await s.storage.bump();
    await memo.anonymous(request("/sign-in"), s.storage, app.render);
    expect(app.calls()).toBe(2);
    const onboarding = createPublicMemo({ now: () => now });
    const screens = pageRenders();
    await onboarding.anonymous(
      request("/onboarding"),
      undefined,
      screens.render
    );
    await onboarding.anonymous(
      request("/onboarding"),
      undefined,
      screens.render
    );
    expect(screens.calls()).toBe(1);
  });
});
