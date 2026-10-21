import { afterEach, describe, expect, test } from "bun:test";
import {
  generateInstallKey,
  type InstallKey,
  importInstallKey,
} from "@/server/boot/installkey.ts";
import {
  clientAddressHeader,
  requestOriginHeader,
} from "@/server/boot/proxies.ts";
import { createIncident } from "@/server/incidents/incidents.ts";
import { createWindow } from "@/server/maintenance/maintenance.ts";
import {
  createAttemptLimiter,
  issuePass,
  passCookie,
} from "@/server/pages/access.ts";
import { createComponent } from "@/server/pages/components.ts";
import {
  type PagesScratch,
  publish,
  scratchPages,
} from "@/server/pages/fixture.ts";
import { createPage, savePage } from "@/server/pages/pages.ts";
import type { PublicTarget, ViewTarget } from "@/server/pages/public.ts";
import type { PageAccessInput, StatusPage } from "@/shared/schemas/page.ts";
import { createPublicMemo, type PublicMemo } from "./public.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const now = Date.UTC(2026, 9, 19, 12);
const hour = 3_600_000;
const host = "status.raaqeb.test";
const domain = "status.shop.test";
const password = "correct horse";
const office = "203.0.113.0/24";

async function installKey(): Promise<InstallKey> {
  const key = await importInstallKey(generateInstallKey());
  if (!key) {
    throw new Error("no key");
  }
  return key;
}

function must<T extends { ok: boolean }>(
  result: T
): asserts result is T & { ok: true } {
  if (!result.ok) {
    throw new Error(JSON.stringify(result));
  }
}

/** Two published pages showing one component with one incident and one window: the default page at the bare host, and the shop page at its custom domain. */
async function install(): Promise<{
  incidentId: string;
  main: string;
  s: PagesScratch;
  shop: string;
  windowId: string;
}> {
  scratch = await scratchPages(now);
  const s = scratch;
  const component = await createComponent(s.storage, {
    description: undefined,
    monitorIds: [],
    name: { ar: "الموقع" },
    status: "operational",
  });
  must(component);
  const ids: string[] = [];
  for (const [slug, customDomain] of [
    ["main", undefined],
    ["shop", domain],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: the first page created is the default
    const created = await createPage(s.storage, {
      locale: "ar",
      slug,
      title: slug,
    });
    must(created);
    await s.storage.pages.save(
      created.page.id,
      { ...created.page, customDomain },
      [{ componentId: component.component.id, kind: "component" }]
    );
    await publish(s.storage, created.page.id);
    ids.push(created.page.id);
  }
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
  must(incident);
  const window = await createWindow(
    s.storage,
    {
      componentIds: [component.component.id],
      endsAt: now + 3 * hour,
      message: { ar: "ترقية." },
      startsAt: now + 2 * hour,
      title: { ar: "صيانة" },
    },
    now
  );
  must(window);
  await s.storage.bump();
  return {
    incidentId: incident.incident.id,
    main: ids[0] ?? "",
    s,
    shop: ids[1] ?? "",
    windowId: window.window.id,
  };
}

/** Sets a page's access through the editor's save, its other fields kept. */
async function setAccess(
  s: PagesScratch,
  pageId: string,
  access: PageAccessInput
): Promise<StatusPage> {
  const page = await s.storage.pages.find(pageId);
  if (!page) {
    throw new Error("no page");
  }
  const saved = await savePage(s.storage, pageId, {
    ...page,
    access,
    layout: (await s.storage.pages.layout(pageId)).map((item) =>
      item.kind === "component"
        ? item
        : { ...item, componentIds: [...item.componentIds] }
    ),
  });
  must(saved);
  return saved.page;
}

/** How a request may hold access: none, the page's pass, an allowed address, a live session. */
type Way = "none" | "pass" | "address" | "session";
const ways: readonly Way[] = ["none", "pass", "address", "session"];

/** The access modes, the password and the allowed addresses together among them. */
const modes = {
  public: { addresses: [], mode: "public" },
  password: { addresses: [], mode: "password", password },
  password_addresses: {
    addresses: [office],
    mode: "password",
    password,
  },
  signed_in: { addresses: [], mode: "signed_in" },
  addresses: { addresses: [office], mode: "addresses" },
} as const satisfies Record<string, PageAccessInput>;
type ModeName = keyof typeof modes;

/** Which ways let a request into a page of each mode. */
const letIn: Readonly<Record<ModeName, readonly Way[]>> = {
  addresses: ["address", "session"],
  password: ["pass", "session"],
  password_addresses: ["pass", "address", "session"],
  public: ["none", "pass", "address", "session"],
  signed_in: ["session"],
};

/** Every public route kind a page answers, at the bare host for the default page and at its custom domain for the shop page. */
function routes(
  pageId: string,
  incidentId: string,
  windowId: string
): readonly { readonly kind: string; readonly path: string }[] {
  const api = `/api/pages/${pageId}`;
  return [
    { kind: "overview", path: "/" },
    { kind: "overview in the other locale", path: "/en" },
    { kind: "history", path: "/history" },
    { kind: "history month", path: "/history/2026-10" },
    { kind: "incident", path: `/incidents/${incidentId}` },
    { kind: "maintenance", path: `/maintenance/${windowId}` },
    { kind: "overview document", path: `${api}/overview` },
    { kind: "history document", path: `${api}/history` },
    { kind: "history month document", path: `${api}/history/2026-10` },
    { kind: "incident document", path: `${api}/incidents/${incidentId}` },
    { kind: "maintenance document", path: `${api}/maintenance/${windowId}` },
    { kind: "badge", path: "/badge.svg" },
    { kind: "badge in the other locale", path: "/en/badge.svg" },
    { kind: "feed", path: "/feed.atom" },
    { kind: "feed in the other locale", path: "/en/feed.atom" },
    { kind: "summary", path: "/api/v2/summary.json" },
  ];
}

/** The route's renders: each answers a public 200 naming its target; the access page and the not-found answer as Start's not-found does, 404. */
function app() {
  const views: PublicTarget[] = [];
  const missing: { path: string; target: ViewTarget | undefined }[] = [];
  return {
    missing,
    render: (target: PublicTarget) => {
      views.push(target);
      return Promise.resolve(
        new Response(`secret view of ${target.key}`, {
          headers: {
            "cache-control": "public, max-age=0, must-revalidate",
            "content-type": "text/html; charset=utf-8",
          },
        })
      );
    },
    renderMissing: (address: Request, target: ViewTarget | undefined) => {
      missing.push({ path: new URL(address.url).pathname, target });
      const body = target?.locked
        ? `<html><body><main data-slot="access-page">locked ${target.pageId}</main><p data-slot="access-wrong" hidden>wrong</p><p data-slot="access-limited" hidden>limited</p><form method="post"><input name="password" type="password"></form><a data-slot="page-locale" href="/en">English</a><script type="module" src="/assets/index.js"></script></body></html>`
        : `<html><body><main data-slot="view-missing">not found</main></body></html>`;
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 404,
        })
      );
    },
    views,
  };
}

/** A request as the entry hands it on, at `hostName`, with the way of access it holds. */
function request(
  hostName: string,
  path: string,
  way: Way,
  pass: string,
  method = "GET"
): Request {
  const headers: Record<string, string> = {
    [clientAddressHeader]: way === "address" ? "203.0.113.9" : "198.51.100.4",
    [requestOriginHeader]: `https://${hostName}`,
  };
  if (way === "pass") {
    headers.cookie = pass;
  }
  if (way === "session") {
    headers.cookie = "raaqeb.session_token=live";
  }
  return new Request(`https://${hostName}${path}`, { headers, method });
}

/** The memo the entry builds: a session is the request's cookie naming one. */
function memoOf(key: InstallKey): PublicMemo {
  return createPublicMemo({
    key,
    now: () => now,
    operator: (each) =>
      Promise.resolve(
        each.headers.get("cookie")?.includes("raaqeb.session_token") ?? false
      ),
  });
}

/** The Cookie header that carries the page's pass, as its password earns it. */
async function passFor(key: InstallKey, page: StatusPage): Promise<string> {
  const value = await issuePass(key, page, now);
  return passCookie(page.id, value, true).split(";")[0] ?? "";
}

describe("the access matrix: every public route kind, every access mode, with and without access", () => {
  for (const name of Object.keys(modes) as ModeName[]) {
    test(`a page whose access is ${name} answers each way of access as its mode says, at the bare host and at its custom domain, and never answers the kept view to a request without access`, async () => {
      const { incidentId, main, s, shop, windowId } = await install();
      const key = await installKey();
      const memo = memoOf(key);
      const route = app();
      const pages = [
        { hostName: host, page: await setAccess(s, main, modes[name]) },
        { hostName: domain, page: await setAccess(s, shop, modes[name]) },
      ];
      const asked: { answer: Response | undefined; label: string }[] = [];
      for (const { hostName, page } of pages) {
        // biome-ignore lint/performance/noAwaitInLoops: one page after the other
        const pass = await passFor(key, page);
        for (const { kind, path } of routes(page.id, incidentId, windowId)) {
          // Each way in the order the matrix lists it: an allowed request fills the memo before a request without access asks.
          for (const way of [...ways].sort(
            (a, b) =>
              Number(letIn[name].includes(b)) - Number(letIn[name].includes(a))
          )) {
            for (const method of ["GET", "HEAD"]) {
              // biome-ignore lint/performance/noAwaitInLoops: one request at a time, so each finds what the one before kept
              const answer = await memo.answer(
                request(hostName, path, way, pass, method),
                s.storage,
                route.render,
                undefined,
                route.renderMissing
              );
              asked.push({
                answer,
                label: `${hostName}${path} (${kind}) ${method} ${way}`,
              });
              const allowed = letIn[name].includes(way);
              expect(answer?.status, `${hostName}${path} ${way}`).toBe(
                allowed ? 200 : 403
              );
              const body = (await answer?.text()) ?? "";
              expect(body.includes("secret view"), `${path} ${way}`).toBe(
                allowed && method === "GET"
              );
              if (name === "public") {
                expect(answer?.headers.get("cache-control")).toContain(
                  "public"
                );
                continue;
              }
              // A private answer is no one else's to keep, and never indexed.
              expect(answer?.headers.get("cache-control"), path).toBe(
                "private, no-store"
              );
              expect(answer?.headers.get("x-robots-tag"), path).toBe("noindex");
              expect(answer?.headers.has("etag"), path).toBe(false);
            }
          }
        }
      }
      expect(asked.length).toBe(2 * 16 * ways.length * 2);
    });
  }

  test("a request without access to a private view gets its page's access page in the address's locale, and its document, badge, feed and summary a plain 403", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    await setAccess(s, main, modes.password);
    const view = await memo.answer(
      request(host, "/incidents/nope", "none", ""),
      s.storage,
      route.render,
      undefined,
      route.renderMissing
    );
    expect(view?.status).toBe(403);
    expect(view?.headers.get("content-type")).toContain("text/html");
    const page = (await view?.text()) ?? "";
    expect(page).toContain('data-slot="access-page"');
    // Still: it never hydrates into the view.
    expect(page).not.toContain("<script");
    expect(route.missing.at(-1)?.target).toMatchObject({
      locked: true,
      pageId: main,
    });
    const english = await memo.answer(
      request(host, "/en/history", "none", ""),
      s.storage,
      route.render,
      undefined,
      route.renderMissing
    );
    expect(english?.status).toBe(403);
    // The language switch keeps the address.
    expect(await english?.text()).toContain('href="/history"');
    expect(route.missing.at(-1)?.target).toMatchObject({ locale: "en" });
    for (const path of [
      `/api/pages/${main}/overview`,
      "/badge.svg",
      "/feed.atom",
      "/api/v2/summary.json",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time
      const answer = await memo.answer(
        request(host, path, "none", ""),
        s.storage,
        route.render,
        undefined,
        route.renderMissing
      );
      expect(answer?.status, path).toBe(403);
      expect(answer?.headers.get("content-type"), path).toContain("text/plain");
    }
    expect(route.views).toEqual([]);
  });

  test("a stranger's burst on a private page costs one render of its access page and none of its views", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    await setAccess(s, main, modes.password);
    const answers = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        memo.answer(
          request(host, index % 2 ? "/" : "/history", "none", ""),
          s.storage,
          route.render,
          undefined,
          route.renderMissing
        )
      )
    );
    expect(answers.every((answer) => answer?.status === 403)).toBe(true);
    expect(route.missing).toHaveLength(1);
    expect(route.views).toEqual([]);
  });

  test("a private page frames no not-found at an address that names none of its views", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    await setAccess(s, main, modes.signed_in);
    await memo.read(s.storage);
    expect(memo.missing(request(host, "/nope", "none", ""))).toBeUndefined();
    expect(
      memo.missing(request(host, "/status/main/nope", "none", ""))
    ).toBeUndefined();
  });

  test("a page made public again answers everyone, and one made private again asks again", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    const ask = async () =>
      (
        await memo.answer(
          request(host, "/", "none", ""),
          s.storage,
          route.render,
          undefined,
          route.renderMissing
        )
      )?.status;
    await setAccess(s, main, modes.signed_in);
    expect(await ask()).toBe(403);
    await setAccess(s, main, modes.public);
    expect(await ask()).toBe(200);
    await setAccess(s, main, modes.addresses);
    expect(await ask()).toBe(403);
  });
});

describe("a page index that may be stale never answers a private page as public", () => {
  /** The view as a stranger asks it, with the counter the entry read first when given. */
  function ask(
    memo: PublicMemo,
    storage: Parameters<PublicMemo["answer"]>[1],
    route: ReturnType<typeof app>,
    counter?: Promise<number | undefined>
  ) {
    return memo.answer(
      request(host, "/", "none", ""),
      storage,
      route.render,
      counter,
      route.renderMissing
    );
  }

  test("a page made private whose change counter cannot be read then is 403, never the view", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    expect((await ask(memo, s.storage, route))?.status).toBe(200);
    await setAccess(s, main, modes.signed_in);
    const broken = {
      ...s.storage,
      changeCounter: () => Promise.reject(new Error("gone")),
    };
    const answer = await ask(memo, broken, route);
    expect(answer?.status).toBe(403);
    expect(await answer?.text()).not.toContain("secret view");
  });

  test("a page save moves the change counter in its own write, so a separate bump that fails cannot leave the page private and the index public", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    expect((await ask(memo, s.storage, route))?.status).toBe(200);
    const before = await s.storage.changeCounter();
    const page = await s.storage.pages.find(main);
    if (!page) {
      throw new Error("no page");
    }
    const noBump = {
      ...s.storage,
      bump: () => Promise.reject(new Error("gone")),
    };
    const saved = await savePage(noBump, main, {
      ...page,
      access: modes.signed_in,
      layout: [],
    });
    expect(saved.ok).toBe(true);
    expect(await s.storage.changeCounter()).toBeGreaterThan(before);
    expect((await ask(memo, s.storage, route))?.status).toBe(403);
  });

  test("an older read of the pages that lands after a newer one never replaces it", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    await memo.read(s.storage);
    await s.storage.bump();
    let slow = true;
    const delayed = {
      ...s.storage,
      pages: {
        ...s.storage.pages,
        list: async () => {
          const pages = await s.storage.pages.list();
          if (slow) {
            slow = false;
            await Bun.sleep(200);
          }
          return pages;
        },
      },
    };
    // Reads the page while public, and answers late.
    const older = memo.read(delayed);
    await Bun.sleep(20);
    await setAccess(s, main, modes.signed_in);
    await memo.read(delayed);
    const counted = memo.read(delayed);
    await counted;
    await older;
    const answer = await ask(memo, s.storage, route, counted);
    expect(answer?.status).toBe(403);
    expect(route.views).toEqual([]);
  });
});

describe("a visitor's try at a page password", () => {
  /** A form POST at a view's address, from the page's own origin unless told otherwise. */
  function attempt(
    path: string,
    typed: string,
    init: { client?: string; origin?: string; cookie?: string } = {}
  ): Request {
    return new Request(`https://${host}${path}`, {
      body: new URLSearchParams({ password: typed }).toString(),
      headers: {
        [clientAddressHeader]: init.client ?? "198.51.100.4",
        [requestOriginHeader]: `https://${host}`,
        "content-type": "application/x-www-form-urlencoded",
        origin: init.origin ?? `https://${host}`,
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      method: "POST",
    });
  }

  test("the right password answers 303 back to the address with a page pass that opens the page; the pass opens no other page", async () => {
    const { main, s, shop } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    await setAccess(s, main, modes.password);
    await setAccess(s, shop, modes.password);
    const answer = await memo.attempt(
      attempt("/incidents/x?from=mail", password),
      s.storage,
      route.renderMissing
    );
    expect(answer?.status).toBe(303);
    expect(answer?.headers.get("location")).toBe("/incidents/x?from=mail");
    expect(answer?.headers.get("cache-control")).toBe("no-store");
    const setCookie = answer?.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0] ?? "";
    const opened = await memo.answer(
      new Request(`https://${host}/`, {
        headers: {
          [requestOriginHeader]: `https://${host}`,
          cookie,
        },
      }),
      s.storage,
      route.render,
      undefined,
      route.renderMissing
    );
    expect(opened?.status).toBe(200);
    const elsewhere = await memo.answer(
      new Request(`https://${domain}/`, {
        headers: { [requestOriginHeader]: `https://${domain}`, cookie },
      }),
      s.storage,
      route.render,
      undefined,
      route.renderMissing
    );
    expect(elsewhere?.status).toBe(403);
  });

  test("a wrong password answers the access page saying so, and no pass", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    await setAccess(s, main, modes.password);
    const answer = await memo.attempt(
      attempt("/", "wrong horse"),
      s.storage,
      route.renderMissing
    );
    expect(answer?.status).toBe(403);
    expect(answer?.headers.has("set-cookie")).toBe(false);
    const body = (await answer?.text()) ?? "";
    expect(body).toContain('data-slot="access-page"');
    expect(body).toContain('<p data-slot="access-wrong">');
    expect(body).toContain('<p data-slot="access-limited" hidden>');
  });

  test("past its share of tries a client is answered 429 with the access page saying so, before any password is judged, while another client still tries", async () => {
    const { main, s } = await install();
    const memo = createPublicMemo({
      attempts: createAttemptLimiter(2, 60_000, 100),
      key: await installKey(),
      now: () => now,
    });
    const route = app();
    await setAccess(s, main, modes.password);
    let judged = 0;
    const check = async (read: () => Promise<boolean>) => {
      judged += 1;
      return await read();
    };
    for (const typed of ["one wrong", "two wrong"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one try after another
      await memo.attempt(
        attempt("/", typed),
        s.storage,
        route.renderMissing,
        check
      );
    }
    const limited = await memo.attempt(
      attempt("/", password),
      s.storage,
      route.renderMissing,
      check
    );
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).not.toBeNull();
    expect(await limited?.text()).toContain('<p data-slot="access-limited">');
    expect(judged).toBe(2);
    const other = await memo.attempt(
      attempt("/", password, { client: "198.51.100.77" }),
      s.storage,
      route.renderMissing,
      check
    );
    expect(other?.status).toBe(303);
  });

  test("Retry-After says the seconds until the client's oldest try leaves the period", async () => {
    const { main, s } = await install();
    let clock = now;
    const memo = createPublicMemo({
      attempts: createAttemptLimiter(2, 600_000, 100),
      key: await installKey(),
      now: () => clock,
    });
    const route = app();
    await setAccess(s, main, modes.password);
    await memo.attempt(
      attempt("/", "one wrong"),
      s.storage,
      route.renderMissing
    );
    clock += 100_000;
    await memo.attempt(
      attempt("/", "two wrong"),
      s.storage,
      route.renderMissing
    );
    clock += 50_000;
    const limited = await memo.attempt(
      attempt("/", "three wrong"),
      s.storage,
      route.renderMissing
    );
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("450");
  });

  test("the right password never uses up the client's share: it opens the page after wrong tries, and again and again", async () => {
    const { main, s } = await install();
    const memo = createPublicMemo({
      attempts: createAttemptLimiter(2, 600_000, 100),
      key: await installKey(),
      now: () => now,
    });
    const route = app();
    await setAccess(s, main, modes.password);
    await memo.attempt(
      attempt("/", "one wrong"),
      s.storage,
      route.renderMissing
    );
    for (const _ of [1, 2, 3]) {
      // biome-ignore lint/performance/noAwaitInLoops: one try after another
      const right = await memo.attempt(
        attempt("/", password),
        s.storage,
        route.renderMissing
      );
      expect(right?.status).toBe(303);
    }
    const wrong = await memo.attempt(
      attempt("/", "two wrong"),
      s.storage,
      route.renderMissing
    );
    expect(wrong?.status).toBe(403);
  });

  test("a try with no turn free to judge it answers 503", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    await setAccess(s, main, modes.password);
    const answer = await memo.attempt(
      attempt("/", password),
      s.storage,
      route.renderMissing,
      () => Promise.resolve(undefined)
    );
    expect(answer?.status).toBe(503);
  });

  test("a try from another origin is refused before it is counted or judged", async () => {
    const { main, s } = await install();
    const memo = createPublicMemo({
      attempts: createAttemptLimiter(1, 60_000, 100),
      key: await installKey(),
      now: () => now,
    });
    const route = app();
    await setAccess(s, main, modes.password);
    const forged = await memo.attempt(
      attempt("/", password, { origin: "https://evil.test" }),
      s.storage,
      route.renderMissing
    );
    expect(forged?.status).toBe(403);
    expect(forged?.headers.has("set-cookie")).toBe(false);
    const own = await memo.attempt(
      attempt("/", password),
      s.storage,
      route.renderMissing
    );
    expect(own?.status).toBe(303);
  });

  test("a try at a page out of password mode, at an address that is no view, or any other request is not the attempt's", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    await setAccess(s, main, modes.signed_in);
    expect(
      await memo.attempt(attempt("/", password), s.storage, route.renderMissing)
    ).toBeUndefined();
    await setAccess(s, main, modes.password);
    expect(
      await memo.attempt(
        attempt("/sign-in", password),
        s.storage,
        route.renderMissing
      )
    ).toBeUndefined();
    expect(
      await memo.attempt(
        new Request(`https://${host}/`, {
          headers: { [requestOriginHeader]: `https://${host}` },
        }),
        s.storage,
        route.renderMissing
      )
    ).toBeUndefined();
  });

  test("a body past its small bound is refused unread", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    await setAccess(s, main, modes.password);
    const answer = await memo.attempt(
      attempt("/", "x".repeat(10_000)),
      s.storage,
      route.renderMissing
    );
    expect(answer?.status).toBe(413);
  });

  test("a new page password ends the pass the old one earned", async () => {
    const { main, s } = await install();
    const memo = memoOf(await installKey());
    const route = app();
    await setAccess(s, main, modes.password);
    const earned = await memo.attempt(
      attempt("/", password),
      s.storage,
      route.renderMissing
    );
    const cookie = earned?.headers.get("set-cookie")?.split(";")[0] ?? "";
    const view = () =>
      memo.answer(
        new Request(`https://${host}/`, {
          headers: { [requestOriginHeader]: `https://${host}`, cookie },
        }),
        s.storage,
        route.render,
        undefined,
        route.renderMissing
      );
    expect((await view())?.status).toBe(200);
    // Saved again without a new password: the pass still holds.
    await setAccess(s, main, { addresses: [], mode: "password" });
    expect((await view())?.status).toBe(200);
    await setAccess(s, main, {
      addresses: [],
      mode: "password",
      password: "battery staple",
    });
    expect((await view())?.status).toBe(403);
  });
});
