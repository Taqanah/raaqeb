import { describe, expect, test } from "bun:test";
import type { Locale } from "@/shared/i18n/locale.ts";
import {
  defaultCustomization,
  type StatusPage,
} from "@/shared/schemas/page.ts";
import {
  anonymousPageKey,
  canonicalPaths,
  missingAddress,
  missingView,
  type PublicIndex,
  publicIndexOf,
  publicTarget,
  type ResourceTarget,
  rendersDocument,
  unresolvedAt,
  type ViewTarget,
} from "./public.ts";

const address = "https://status.raaqeb.test";
const host = "status.raaqeb.test";

function stored(
  id: string,
  slug: string,
  overrides: Partial<StatusPage> = {}
): StatusPage {
  return {
    createdAt: 0,
    customDomain: undefined,
    customization: defaultCustomization,
    id,
    isDefault: false,
    published: true,
    locale: "ar",
    slug,
    title: { ar: slug },
    updatedAt: 0,
    ...overrides,
  };
}

/** The default page in Arabic, an English page with a custom domain, and a plain Arabic page. */
function index(): PublicIndex {
  return publicIndexOf(
    [
      stored("p-main", "main", { isDefault: true }),
      stored("p-shop", "shop", {
        customDomain: "status.shop.test",
        locale: "en",
      }),
      stored("p-api", "api"),
    ],
    address
  );
}

function view(hostName: string | undefined, path: string): ViewTarget {
  const target = publicTarget(index(), hostName, path);
  if (target?.kind !== "view") {
    throw new Error(`${path} on ${hostName} shows no view`);
  }
  return target;
}

function shows(
  hostName: string | undefined,
  path: string
): { locale: Locale; pageId: string } | undefined {
  const target = publicTarget(index(), hostName, path);
  return target?.kind === "view"
    ? { locale: target.locale, pageId: target.pageId }
    : undefined;
}

describe("the pages index", () => {
  test("keeps each page's id, slug, language, domain and default, and the public address", () => {
    expect(index()).toEqual({
      pages: [
        {
          customDomain: undefined,
          id: "p-main",
          isDefault: true,
          published: true,
          locale: "ar",
          slug: "main",
        },
        {
          customDomain: "status.shop.test",
          id: "p-shop",
          isDefault: false,
          published: true,
          locale: "en",
          slug: "shop",
        },
        {
          customDomain: undefined,
          id: "p-api",
          isDefault: false,
          published: true,
          locale: "ar",
          slug: "api",
        },
      ],
      publicAddress: address,
    });
  });
});

describe("which page a request shows", () => {
  test("the bare host shows the default page in its own language", () => {
    expect(shows(host, "/")).toEqual({ locale: "ar", pageId: "p-main" });
  });

  test("the other locale sits under its prefix", () => {
    expect(shows(host, "/en")).toEqual({ locale: "en", pageId: "p-main" });
    expect(shows(host, "/en/")).toEqual({ locale: "en", pageId: "p-main" });
  });

  test("a prefix in the page's own language is no address", () => {
    expect(shows(host, "/ar")).toBeUndefined();
    expect(shows(host, "/ar/status/api")).toBeUndefined();
    expect(shows(host, "/en/status/shop")).toBeUndefined();
  });

  test("a prefix that is not a locale is no address", () => {
    expect(shows(host, "/fr")).toBeUndefined();
    expect(shows(host, "/fr/status/api")).toBeUndefined();
    expect(shows(host, "/EN")).toBeUndefined();
  });

  test("every page sits at /status/<slug>, the other locale under its prefix", () => {
    expect(shows(host, "/status/api")).toEqual({
      locale: "ar",
      pageId: "p-api",
    });
    expect(shows(host, "/en/status/api")).toEqual({
      locale: "en",
      pageId: "p-api",
    });
    expect(shows(host, "/status/shop")).toEqual({
      locale: "en",
      pageId: "p-shop",
    });
    expect(shows(host, "/ar/status/shop")).toEqual({
      locale: "ar",
      pageId: "p-shop",
    });
    expect(shows(host, "/status/main")).toEqual({
      locale: "ar",
      pageId: "p-main",
    });
  });

  test("an unknown slug, a trailing path and a slug in capitals show nothing", () => {
    expect(shows(host, "/status/nope")).toBeUndefined();
    expect(shows(host, "/status/api/more")).toBeUndefined();
    expect(shows(host, "/status/API")).toBeUndefined();
    expect(shows(host, "/status/")).toBeUndefined();
  });

  test("a custom domain shows its page alone, at / and under the other locale's prefix", () => {
    expect(shows("status.shop.test", "/")).toEqual({
      locale: "en",
      pageId: "p-shop",
    });
    expect(shows("status.shop.test", "/ar")).toEqual({
      locale: "ar",
      pageId: "p-shop",
    });
    expect(shows("status.shop.test", "/status/api")).toBeUndefined();
    expect(shows("status.shop.test", "/status/shop")).toBeUndefined();
    expect(shows("status.shop.test", "/en")).toBeUndefined();
  });

  test("a custom domain is matched in its stored form: any case, one trailing dot, no port", () => {
    expect(shows("Status.Shop.TEST", "/")?.pageId).toBe("p-shop");
    expect(shows("status.shop.test.", "/")?.pageId).toBe("p-shop");
  });

  test("a host no page claims is the public address's host, and so is no host at all", () => {
    expect(shows("127.0.0.1", "/")?.pageId).toBe("p-main");
    expect(shows("localhost", "/status/api")?.pageId).toBe("p-api");
    expect(shows(undefined, "/")?.pageId).toBe("p-main");
  });

  test("with no default page the bare host shows nothing", () => {
    const none = publicIndexOf([stored("p-api", "api")], address);
    expect(publicTarget(none, host, "/")).toBeUndefined();
    expect(publicTarget(none, host, "/en")).toBeUndefined();
    expect(publicTarget(none, host, "/status/api")?.kind).toBe("view");
  });

  test("the admin, auth and API paths are no view", () => {
    for (const path of [
      "/admin",
      "/admin/monitors",
      "/sign-in",
      "/onboarding",
      "/health",
      "/api/pages/p-api/logo",
      "/assets/app.js",
    ]) {
      expect(publicTarget(index(), host, path)).toBeUndefined();
    }
  });
});

/** The view and page a request shows, or nothing. */
function viewAt(
  hostName: string | undefined,
  path: string
): { pageId: string; view: string } | undefined {
  const target = publicTarget(index(), hostName, path);
  return target?.kind === "view"
    ? { pageId: target.pageId, view: target.view }
    : undefined;
}

describe("the other views' addresses", () => {
  test("the overview's own addresses show the overview", () => {
    expect(viewAt(host, "/")?.view).toBe("overview");
    expect(viewAt(host, "/en/status/api")?.view).toBe("overview");
    expect(viewAt("status.shop.test", "/ar")?.view).toBe("overview");
  });

  test("each view hangs from the default page's bare host, in both locales", () => {
    for (const [path, name] of [
      ["/history", "history"],
      ["/history/2026-09", "history"],
      ["/incidents/i-1", "incident"],
      ["/maintenance/w-1", "maintenance"],
      ["/en/history", "history"],
      ["/en/history/2026-09", "history"],
      ["/en/incidents/i-1", "incident"],
      ["/en/maintenance/w-1", "maintenance"],
    ] as const) {
      expect(viewAt(host, path), path).toEqual({
        pageId: "p-main",
        view: name,
      });
    }
  });

  test("each view hangs from /status/<slug>, the other locale under its prefix", () => {
    expect(viewAt(host, "/status/api/history")).toEqual({
      pageId: "p-api",
      view: "history",
    });
    expect(viewAt(host, "/en/status/api/history/2025-12")).toEqual({
      pageId: "p-api",
      view: "history",
    });
    expect(viewAt(host, "/status/api/incidents/i-1")).toEqual({
      pageId: "p-api",
      view: "incident",
    });
    expect(viewAt(host, "/ar/status/shop/maintenance/w-1")).toEqual({
      pageId: "p-shop",
      view: "maintenance",
    });
    expect(viewAt(host, "/status/main/history")).toEqual({
      pageId: "p-main",
      view: "history",
    });
  });

  test("a custom domain's views hang from its bare host", () => {
    expect(viewAt("status.shop.test", "/history")).toEqual({
      pageId: "p-shop",
      view: "history",
    });
    expect(viewAt("status.shop.test", "/ar/incidents/i-1")).toEqual({
      pageId: "p-shop",
      view: "incident",
    });
    expect(viewAt("status.shop.test", "/status/shop/history")).toBeUndefined();
  });

  test("a month that is not yyyy-mm, a view with no id or a path past a view shows nothing", () => {
    for (const path of [
      "/history/2026-9",
      "/history/2026-13",
      "/history/2026-09-01",
      "/history/sept",
      "/incidents",
      "/incidents/",
      "/maintenance",
      "/incidents/i-1/more",
      "/status/api/history/2026-09/more",
      "/status/api/updates",
    ]) {
      expect(viewAt(host, path), path).toBeUndefined();
    }
  });

  test("a view in the page's own language prefix shows nothing", () => {
    expect(viewAt(host, "/ar/history")).toBeUndefined();
    expect(viewAt(host, "/en/status/shop/incidents/i-1")).toBeUndefined();
  });

  test("with no default page the bare host's views show nothing", () => {
    const none = publicIndexOf([stored("p-api", "api")], address);
    expect(publicTarget(none, host, "/history")).toBeUndefined();
    expect(publicTarget(none, host, "/incidents/i-1")).toBeUndefined();
  });

  test("every view of a page carries the page's plain addresses, whichever view was asked for", () => {
    expect(view(host, "/en/status/api/incidents/i-1").paths.bases).toEqual({
      ar: "/status/api",
      en: "/en/status/api",
    });
    expect(view(host, "/status/main/history").paths.bases).toEqual({
      ar: "",
      en: "/en",
    });
  });

  test("each view's address is its own memo key", () => {
    expect(view(host, "/history").key).toBe("p-main ar main /history");
    expect(view(host, "/en/incidents/i-1").key).toBe(
      "p-main en main /en/incidents/i-1"
    );
    expect(view(host, "/history/2026-08").key).not.toBe(
      view(host, "/history/2026-09").key
    );
  });
});

describe("a view's document", () => {
  test("/api/pages/<id>/overview is the page's overview document on any host", () => {
    for (const hostName of [host, "status.shop.test", undefined]) {
      expect(
        publicTarget(index(), hostName, "/api/pages/p-api/overview")
      ).toEqual({
        key: "p-api document /overview",
        kind: "document",
        pageId: "p-api",
        published: true,
        view: "overview",
      });
    }
  });

  test("each view's document hangs from the page's API address on any host", () => {
    for (const [suffix, name] of [
      ["/history", "history"],
      ["/history/2026-09", "history"],
      ["/incidents/i-1", "incident"],
      ["/maintenance/w-1", "maintenance"],
    ] as const) {
      for (const hostName of [host, "status.shop.test"]) {
        expect(
          publicTarget(index(), hostName, `/api/pages/p-api${suffix}`)
        ).toEqual({
          key: `p-api document ${suffix}`,
          kind: "document",
          pageId: "p-api",
          published: true,
          view: name,
        });
      }
    }
  });

  test("a document path that names no view is not the memo's", () => {
    for (const suffix of [
      "/history/2026-13",
      "/history/2026-9",
      "/incidents",
      "/incidents/i-1/more",
      "/maintenance/",
      "/updates",
    ]) {
      expect(
        publicTarget(index(), host, `/api/pages/p-api${suffix}`),
        suffix
      ).toBeUndefined();
    }
  });

  test("a malformed escape in a document path names no view", () => {
    expect(
      publicTarget(index(), host, "/api/pages/p-api/incidents/%E0")
    ).toBeUndefined();
    expect(
      publicTarget(index(), host, "/api/pages/%E0/overview")
    ).toBeUndefined();
  });

  test("an escaped id in a document path is the same document as the plain one", () => {
    expect(
      publicTarget(index(), host, "/api/pages/p%2Dapi/incidents/i%2D1")?.key
    ).toBe("p-api document /incidents/i-1");
  });

  test("an unknown page's document is not the memo's", () => {
    expect(
      publicTarget(index(), host, "/api/pages/nope/overview")
    ).toBeUndefined();
  });

  test("one document serves both locales", () => {
    expect(publicTarget(index(), host, "/api/pages/p-main/overview")?.key).toBe(
      publicTarget(index(), "status.shop.test", "/api/pages/p-main/overview")
        ?.key
    );
  });
});

describe("the memo's key", () => {
  test("names the page, the locale, the host the request came through and the path", () => {
    expect(view(host, "/").key).toBe("p-main ar main /");
    expect(view(host, "/en").key).toBe("p-main en main /en");
    expect(view("status.shop.test", "/").key).toBe("p-shop en domain /");
  });

  test("any host no page claims shares the public address's entries", () => {
    expect(view("127.0.0.1", "/status/api").key).toBe(
      view(host, "/status/api").key
    );
  });

  test("a trailing slash reads as the same address", () => {
    expect(view(host, "/en/").key).toBe(view(host, "/en").key);
  });
});

describe("a view's addresses", () => {
  test("the default page's plain addresses are the bare host and the prefix, on the public address", () => {
    expect(view(host, "/en").paths).toEqual({
      bases: { ar: "", en: "/en" },
      origin: address,
    });
  });

  test("another page's plain addresses are /status/<slug> and its prefix", () => {
    expect(view(host, "/status/api").paths.bases).toEqual({
      ar: "/status/api",
      en: "/en/status/api",
    });
    expect(view(host, "/status/shop").paths.bases).toEqual({
      ar: "/ar/status/shop",
      en: "/status/shop",
    });
  });

  test("on its custom domain a page is known by / and the prefix over https", () => {
    expect(view("status.shop.test", "/ar").paths).toEqual({
      bases: { ar: "/ar", en: "" },
      origin: "https://status.shop.test",
    });
  });

  test("with no public address stored the main host's views have no origin", () => {
    const bare = publicIndexOf(
      [stored("p-main", "main", { isDefault: true })],
      undefined
    );
    const target = publicTarget(bare, host, "/");
    expect(
      target?.kind === "view" ? target.paths.origin : "none"
    ).toBeUndefined();
  });
});

describe("edges of the resolution", () => {
  test("a custom domain on a page that is also the default serves it at its domain and at the bare host", () => {
    const both = publicIndexOf(
      [
        stored("p-main", "main", {
          customDomain: "status.shop.test",
          isDefault: true,
          published: true,
        }),
      ],
      address
    );
    const onDomain = publicTarget(both, "status.shop.test", "/");
    const onHost = publicTarget(both, host, "/");
    expect(onDomain?.kind === "view" && onDomain.pageId).toBe("p-main");
    expect(onHost?.kind === "view" && onHost.pageId).toBe("p-main");
    // Their addresses differ, so they are two entries of the memo.
    expect(onDomain?.key).not.toBe(onHost?.key);
  });
});

/** The badge, feed or summary a request shows: the page, the locale and which. */
function resourceAt(
  hostName: string | undefined,
  path: string
): Pick<ResourceTarget, "locale" | "pageId" | "resource"> | undefined {
  const target = publicTarget(index(), hostName, path);
  return target?.kind === "resource"
    ? {
        locale: target.locale,
        pageId: target.pageId,
        resource: target.resource,
      }
    : undefined;
}

describe("a page's badge, feed and summary addresses", () => {
  test("the badge and the feed hang from the default page's bare host, in both locales", () => {
    expect(resourceAt(host, "/badge.svg")).toEqual({
      locale: "ar",
      pageId: "p-main",
      resource: "badge",
    });
    expect(resourceAt(host, "/en/badge.svg")).toEqual({
      locale: "en",
      pageId: "p-main",
      resource: "badge",
    });
    expect(resourceAt(host, "/feed.atom")).toEqual({
      locale: "ar",
      pageId: "p-main",
      resource: "feed",
    });
    expect(resourceAt(host, "/en/feed.atom")).toEqual({
      locale: "en",
      pageId: "p-main",
      resource: "feed",
    });
  });

  test("the badge and the feed hang from /status/<slug>, the other locale under its prefix", () => {
    expect(resourceAt(host, "/status/api/badge.svg")).toEqual({
      locale: "ar",
      pageId: "p-api",
      resource: "badge",
    });
    expect(resourceAt(host, "/ar/status/shop/feed.atom")).toEqual({
      locale: "ar",
      pageId: "p-shop",
      resource: "feed",
    });
  });

  test("a custom domain's badge and feed hang from its bare host", () => {
    expect(resourceAt("status.shop.test", "/feed.atom")).toEqual({
      locale: "en",
      pageId: "p-shop",
      resource: "feed",
    });
    expect(resourceAt("status.shop.test", "/ar/badge.svg")).toEqual({
      locale: "ar",
      pageId: "p-shop",
      resource: "badge",
    });
    expect(resourceAt("status.shop.test", "/status/shop/badge.svg")).toBe(
      undefined
    );
  });

  test("the summary sits at the page's plain address alone, in the page language", () => {
    expect(resourceAt(host, "/api/v2/summary.json")).toEqual({
      locale: "ar",
      pageId: "p-main",
      resource: "summary",
    });
    expect(resourceAt(host, "/status/api/api/v2/summary.json")).toEqual({
      locale: "ar",
      pageId: "p-api",
      resource: "summary",
    });
    expect(resourceAt("status.shop.test", "/api/v2/summary.json")).toEqual({
      locale: "en",
      pageId: "p-shop",
      resource: "summary",
    });
  });

  test("the summary has no address under a locale prefix", () => {
    expect(resourceAt(host, "/en/api/v2/summary.json")).toBe(undefined);
    expect(resourceAt(host, "/ar/status/shop/api/v2/summary.json")).toBe(
      undefined
    );
    expect(resourceAt("status.shop.test", "/ar/api/v2/summary.json")).toBe(
      undefined
    );
  });

  test("a prefix in the page's own language, a path past one and a near name are no address", () => {
    for (const path of [
      "/ar/badge.svg",
      "/en/status/shop/feed.atom",
      "/badge.svg/x",
      "/badge.png",
      "/feed.rss",
      "/feed.atom.xml",
      "/api/v2/status.json",
      "/api/v2/summary",
    ]) {
      expect(publicTarget(index(), host, path), path).toBe(undefined);
    }
  });

  test("with no default page the bare host's badge, feed and summary show nothing", () => {
    const none = publicIndexOf([stored("p-api", "api")], address);
    for (const path of ["/badge.svg", "/feed.atom", "/api/v2/summary.json"]) {
      expect(publicTarget(none, host, path), path).toBe(undefined);
    }
  });

  test("each carries the page's plain addresses and its own memo key", () => {
    const badge = publicTarget(index(), host, "/en/status/api/badge.svg");
    expect(badge?.kind === "resource" && badge.paths).toEqual({
      bases: { ar: "/status/api", en: "/en/status/api" },
      origin: address,
    });
    const keys = [
      "/badge.svg",
      "/en/badge.svg",
      "/feed.atom",
      "/en/feed.atom",
      "/api/v2/summary.json",
      "/",
    ].map((path) => publicTarget(index(), host, path)?.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(publicTarget(index(), host, "/feed.atom")?.key).toBe(
      "p-main ar main /feed.atom"
    );
  });
});

describe("a page's addresses as its messages name them", () => {
  const [main, shop, api] = index().pages;

  test("the default page is at the public address's bare host, the other locale under its prefix", () => {
    expect(canonicalPaths(defined(main), address)).toEqual({
      bases: { ar: "", en: "/en" },
      origin: address,
    });
  });

  test("any other page is at /status/<slug> there", () => {
    expect(canonicalPaths(defined(api), address)).toEqual({
      bases: { ar: "/status/api", en: "/en/status/api" },
      origin: address,
    });
  });

  test("a page with its own domain is at that domain's bare host, whatever the public address", () => {
    expect(canonicalPaths(defined(shop), address)).toEqual({
      bases: { ar: "/ar", en: "" },
      origin: "https://status.shop.test",
    });
  });

  test("with no public address stored, the addresses are paths", () => {
    expect(canonicalPaths(defined(api), undefined)).toEqual({
      bases: { ar: "/status/api", en: "/en/status/api" },
      origin: undefined,
    });
  });
});

describe("the page a not-found shows its frame in", () => {
  test("an unknown slug, a malformed month or any other path on the public host is framed by the default page", () => {
    for (const path of [
      "/status/nope",
      "/history/2026-13",
      "/history/sept",
      "/incidents",
      "/nope/deeper",
    ]) {
      expect(missingView(index(), host, path), path).toEqual({
        locale: "ar",
        pageId: "p-main",
        paths: { bases: { ar: "", en: "/en" }, origin: address },
      });
    }
  });

  test("an address under a page's slug is framed by that page", () => {
    expect(missingView(index(), host, "/status/api/history/2026-13")).toEqual({
      locale: "ar",
      pageId: "p-api",
      paths: {
        bases: { ar: "/status/api", en: "/en/status/api" },
        origin: address,
      },
    });
  });

  test("a locale prefix names no language for the frame: it is the page language, and the not-found takes the document's", () => {
    expect(missingView(index(), host, "/en/status/nope")).toMatchObject({
      locale: "ar",
      pageId: "p-main",
    });
    expect(
      missingView(index(), host, "/en/status/api/history/2026-13")
    ).toMatchObject({ locale: "ar", pageId: "p-api" });
    expect(missingView(index(), host, "/ar/history")).toMatchObject({
      locale: "ar",
      pageId: "p-main",
    });
  });

  test("on a custom domain it is the domain's own page, whatever the path names", () => {
    expect(missingView(index(), "status.shop.test", "/status/api")).toEqual({
      locale: "en",
      pageId: "p-shop",
      paths: {
        bases: { ar: "/ar", en: "" },
        origin: "https://status.shop.test",
      },
    });
  });

  test("with no default page an unknown slug has no frame, and an install with no pages has none anywhere", () => {
    const noDefault = publicIndexOf([stored("p-api", "api")], address);
    expect(missingView(noDefault, host, "/status/nope")).toBeUndefined();
    expect(missingView(noDefault, host, "/status/api/nope")).toMatchObject({
      pageId: "p-api",
    });
    const none = publicIndexOf([], address);
    for (const path of ["/status/missing", "/history/2026-13", "/"]) {
      expect(missingView(none, host, path), path).toBeUndefined();
    }
  });
});

describe("an unpublished page", () => {
  /** The default page and the custom domain's page unpublished, the plain Arabic page published. */
  function drafts(): PublicIndex {
    return publicIndexOf(
      [
        stored("p-main", "main", { isDefault: true, published: false }),
        stored("p-shop", "shop", {
          customDomain: "status.shop.test",
          locale: "en",
          published: false,
        }),
        stored("p-api", "api"),
      ],
      address
    );
  }

  test("the index keeps whether each page is published", () => {
    expect(drafts().pages.map((page) => [page.id, page.published])).toEqual([
      ["p-main", false],
      ["p-shop", false],
      ["p-api", true],
    ]);
  });

  test("its views, documents, badge, feed and summary resolve as unpublished, at its slug, its custom domain and the bare host it is the default of", () => {
    for (const [hostName, path] of [
      [host, "/"],
      [host, "/en"],
      [host, "/status/main/history"],
      [host, "/badge.svg"],
      [host, "/feed.atom"],
      [host, "/api/v2/summary.json"],
      [host, "/api/pages/p-main/overview"],
      ["status.shop.test", "/"],
      ["status.shop.test", "/ar/incidents/i-1"],
      [host, "/status/shop/feed.atom"],
    ] as const) {
      expect(publicTarget(drafts(), hostName, path)?.published, path).toBe(
        false
      );
    }
  });

  test("a published page's targets resolve as published beside it", () => {
    for (const path of [
      "/status/api",
      "/status/api/badge.svg",
      "/api/pages/p-api/history",
    ]) {
      expect(publicTarget(drafts(), host, path)?.published, path).toBe(true);
    }
  });

  test("it frames no not-found: an address under its slug is framed by a published default page, and with the default unpublished the bare host's not-found has no frame", () => {
    const publishedDefault = publicIndexOf(
      [
        stored("p-main", "main", { isDefault: true }),
        stored("p-api", "api", { published: false }),
      ],
      address
    );
    expect(
      missingView(publishedDefault, host, "/status/api/history/2026-13")
    ).toMatchObject({ pageId: "p-main" });
    for (const path of ["/status/nope", "/status/main/nope", "/history/x"]) {
      expect(missingView(drafts(), host, path), path).toBeUndefined();
    }
    expect(missingView(drafts(), "status.shop.test", "/nope")).toBeUndefined();
    expect(
      missingView(drafts(), host, "/status/api/history/2026-13")
    ).toMatchObject({ pageId: "p-api" });
  });
});

describe("who answers an address no page resolves", () => {
  test("a scanner's guess is a page's not-found, whatever its depth", () => {
    for (const path of [
      "/.env",
      "/.env.prod",
      "/old/.env",
      "/.git/config",
      "/credentials.json",
      "/composer.json",
      "/wp-admin/setup.php",
      "/en/sign-in",
      "/status/nope/x/y",
      "/incidents",
      "/history/2026-13",
      "/design",
    ]) {
      expect(unresolvedAt(path), path).toBe("page");
    }
  });

  test("an address under /api/ that no API route has is the API's not-found, never a page's", () => {
    for (const path of [
      "/api",
      "/api/",
      "/api/nope",
      "/api/v2/monitors",
      "/api/v2/summary",
      "/api/pages",
      "/api/heartbeat",
      "/api/heartbeat/token/failed",
      "/api/heartbeat/token/fail/more",
    ]) {
      expect(unresolvedAt(path), path).toBe("api");
    }
  });

  test("an address one of the app's own routes answers is the route's", () => {
    for (const path of [
      "/",
      "/admin",
      "/admin/nope/at/any/depth",
      "/sign-in",
      "/sign-in/",
      "/sign-out",
      "/forgot-password",
      "/reset-password",
      "/onboarding",
      "/onboarding/account",
      "/health",
      "/metrics",
      "/subscriptions/token/",
      "/subscriptions/token/confirm",
      "/_serverFn/routes.__root--readDocument",
      "/api/auth/get-session",
      "/api/heartbeat/token",
      "/api/heartbeat/token/fail",
      "/API/Heartbeat/token/FAIL/",
      "/api/pages/id/overview",
      "/api/pages/id/logo",
      "/api/v2/summary.json",
      "/badge.svg",
      "/en/feed.atom",
      "/status/slug/badge.svg",
      "/en/status/slug/feed.atom",
      "/status/slug/api/v2/summary.json",
    ]) {
      expect(unresolvedAt(path), path).toBe("route");
    }
  });

  test("a route's address is its route's whatever its case, as the router matches it", () => {
    for (const path of [
      "/ADMIN/IMPORT",
      "/Admin/Import/",
      "/SIGN-IN",
      "/API/AUTH/get-session",
      "/Api/OpenAPI.json",
    ]) {
      expect(unresolvedAt(path), path).toBe("route");
    }
    expect(unresolvedAt("/API/NOPE")).toBe("api");
  });

  test("every route the app has is still answered by it, or is a view's address, which a page resolves first", async () => {
    const tree = await Bun.file(
      `${import.meta.dir}/../../routeTree.gen.ts`
    ).text();
    const byFullPath = tree.slice(
      tree.indexOf("interface FileRoutesByFullPath"),
      tree.indexOf("interface FileRoutesByTo")
    );
    const fullPaths = [...byFullPath.matchAll(fullPathPattern)].map(
      ([, path]) => path ?? ""
    );
    expect(fullPaths.length).toBeGreaterThan(50);
    for (const fullPath of fullPaths) {
      const sample = fullPath
        .replaceAll("$month", "2026-01")
        .replace(splatPattern, "/any/depth")
        .replaceAll(parameterPattern, "x");
      // Built for development alone: under the entry it is never found.
      if (sample === "/design") {
        continue;
      }
      for (const prefix of sample.startsWith("/{-x}") ? ["", "/en"] : [""]) {
        const path = sample.replace("/{-x}", prefix) || "/";
        const answered = unresolvedAt(path);
        const isView = viewPattern.test(path) && path !== "/";
        expect(
          isView ? answered !== "api" : answered === "route",
          `${fullPath} at ${path}: ${answered}`
        ).toBe(true);
      }
    }
  });
});

const fullPathPattern = /"(\/[^"]*)": typeof/g;
const splatPattern = /\/\$$/;
const parameterPattern = /\$[A-Za-z]+/g;
/** A view's address under either locale and either base: the memo resolves it when a page has it. */
const viewPattern =
  /^(\/en)?(\/status\/x)?(\/|\/history\/?.*|\/incidents\/x|\/maintenance\/x)?$/;

describe("a document the app renders", () => {
  test("is any route's page, the admin's and the bare host's included", () => {
    for (const path of [
      "/",
      "/sign-in",
      "/admin/monitors",
      "/onboarding/account",
      "/subscriptions/token",
    ]) {
      expect(rendersDocument(path), path).toBe(true);
    }
  });

  test("is never the API's answer, a server function's, the health check's, the metrics endpoint's, a badge's, feed's or summary's, or a subscription's links", () => {
    for (const path of [
      "/api/openapi.json",
      "/api/auth/get-session",
      "/_serverFn/routes.__root--readDocument",
      "/health",
      "/metrics",
      "/badge.svg",
      "/en/status/slug/feed.atom",
      "/status/slug/api/v2/summary.json",
      "/subscriptions/token/confirm",
      "/subscriptions/token/unsubscribe",
    ]) {
      expect(rendersDocument(path), path).toBe(false);
    }
  });
});

describe("a page everyone without a session gets the same", () => {
  test("is sign-in, forgot-password, sign-out, a reset page with no link and onboarding's language and database screens, by address and locale", () => {
    expect(anonymousPageKey("/sign-in", "")).toBe("/sign-in");
    expect(anonymousPageKey("/sign-in", "?locale=en")).toBe("/sign-in en");
    expect(anonymousPageKey("/forgot-password", "?locale=ar")).toBe(
      "/forgot-password ar"
    );
    for (const path of [
      "/sign-out",
      "/reset-password",
      "/onboarding",
      "/onboarding/database",
    ]) {
      expect(anonymousPageKey(path, ""), path).toBe(path);
    }
  });

  test("is never onboarding's account screen, which fills in the address the request came through", () => {
    expect(anonymousPageKey("/onboarding/account", "")).toBeUndefined();
  });

  test("is no page when the search holds anything but a locale the install ships, a reset link included, or the address is spelled otherwise", () => {
    for (const [path, search] of [
      ["/sign-in", "?x=1"],
      ["/sign-in", "?locale=en&x=1"],
      ["/sign-in", "?locale=fr"],
      ["/reset-password", "?token=abc"],
      ["/SIGN-IN", ""],
      ["/sign-in/", ""],
      ["/admin", ""],
      ["/", ""],
    ] as const) {
      expect(
        anonymousPageKey(path, search),
        `${path}${search}`
      ).toBeUndefined();
    }
  });
});

describe("the address a frame's not-found renders at", () => {
  test("a month no history has, under the plain address of the page that frames it, or the bare host's when none does", () => {
    expect(missingAddress(undefined)).toBe("/history/0000-00");
    expect(
      missingAddress({
        locale: "ar",
        pageId: "p-main",
        paths: { bases: { ar: "", en: "/en" }, origin: address },
      })
    ).toBe("/history/0000-00");
    expect(
      missingAddress({
        locale: "en",
        pageId: "p-docs",
        paths: {
          bases: { ar: "/ar/status/docs", en: "/status/docs" },
          origin: address,
        },
      })
    ).toBe("/status/docs/history/0000-00");
  });

  test("names no view, and the same page frames it", () => {
    for (const frame of [
      missingView(index(), host, "/nope"),
      missingView(index(), host, "/status/api/nope"),
    ]) {
      const at = missingAddress(frame);
      expect(publicTarget(index(), host, at), at).toBeUndefined();
      expect(unresolvedAt(at), at).toBe("page");
      expect(missingView(index(), host, at), at).toEqual(frame);
    }
  });
});

/** The value, or a failed test when there is none. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}
