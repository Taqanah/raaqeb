import { afterEach, describe, expect, test } from "bun:test";
import { customDomainOf, defaultCustomization } from "@/shared/schemas/page.ts";
import {
  type CustomDomainStorage,
  customDomainResponse,
  customDomainServed,
} from "./custom-domain.ts";
import { type PagesScratch, scratchPages } from "./fixture.ts";
import { createPage, savePage } from "./pages.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

/** An install with one page on `status.example.test`, published or not, and one on no domain. */
async function world(published: boolean) {
  const s = await scratchPages();
  scratch = s;
  for (const [slug, customDomain] of [
    ["main", "status.example.test"],
    ["other", undefined],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: two pages, one after the other
    const made = await createPage(s.storage, {
      locale: "ar",
      slug,
      title: slug,
    });
    if (!made.ok) {
      throw new Error(made.reason);
    }
    const saved = await savePage(s.storage, made.page.id, {
      customDomain,
      customization: defaultCustomization,
      isDefault: slug === "other",
      layout: [],
      locale: "ar",
      published,
      slug,
      title: { ar: slug },
    });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
  }
  return s.storage;
}

/** Storage whose every read fails, as a database that stopped answering. */
const broken: CustomDomainStorage = {
  pages: {
    list: () => Promise.reject(new Error("the database did not answer")),
  },
};

describe("the custom domain question", () => {
  test("a domain a published status page holds may have a certificate, asked in any case and with a trailing dot", async () => {
    const storage = await world(true);
    expect(await customDomainServed(storage, "status.example.test")).toBe(
      "served"
    );
    expect(await customDomainServed(storage, "Status.Example.TEST.")).toBe(
      "served"
    );
  });

  test("an internationalized domain is asked in either form", async () => {
    const s = await scratchPages();
    scratch = s;
    const made = await createPage(s.storage, {
      locale: "ar",
      slug: "main",
      title: "main",
    });
    if (!made.ok) {
      throw new Error(made.reason);
    }
    const saved = await savePage(s.storage, made.page.id, {
      // Stored as the editor's schema stores it, in its ASCII form.
      customDomain: customDomainOf("حالة.example.test"),
      customization: defaultCustomization,
      isDefault: true,
      layout: [],
      locale: "ar",
      published: true,
      slug: "main",
      title: { ar: "main" },
    });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    expect(
      await customDomainServed(s.storage, "xn--mgbek7g.example.test")
    ).toBe("served");
    expect(await customDomainServed(s.storage, "حالة.example.test")).toBe(
      "served"
    );
  });

  test("an unpublished page's domain gets no certificate, so it reveals no page", async () => {
    const storage = await world(false);
    expect(await customDomainServed(storage, "status.example.test")).toBe(
      "unknown"
    );
  });

  test("a domain no page holds gets no certificate", async () => {
    const storage = await world(true);
    expect(await customDomainServed(storage, "stranger.example.com")).toBe(
      "unknown"
    );
    expect(await customDomainServed(storage, "example.test")).toBe("unknown");
  });

  test("text that names no domain is refused without reading the database", async () => {
    for (const text of [
      null,
      "",
      "https://status.example.test/",
      "status.example.test:443",
      "192.0.2.10",
      "localhost",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one text at a time
      expect(await customDomainServed(broken, text), String(text)).toBe(
        "unknown"
      );
    }
  });

  test("no open database, or one that does not answer, is unavailable", async () => {
    expect(await customDomainServed(undefined, "status.example.test")).toBe(
      "unavailable"
    );
    expect(await customDomainServed(broken, "status.example.test")).toBe(
      "unavailable"
    );
  });
});

describe("the answer to the proxy", () => {
  test("is 200 OK, 404 Not Found or 503 Service Unavailable, the HTTP reason phrases, as plain text, never cached", async () => {
    for (const [answer, status, text] of [
      ["served", 200, "OK"],
      ["unknown", 404, "Not Found"],
      ["unavailable", 503, "Service Unavailable"],
    ] as const) {
      const response = customDomainResponse(answer, "GET");
      expect(response.status).toBe(status);
      // biome-ignore lint/performance/noAwaitInLoops: one answer at a time
      expect(await response.text()).toBe(text);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe(
        "text/plain; charset=utf-8"
      );
    }
  });

  test("a HEAD gets the status and no body", async () => {
    const response = customDomainResponse("served", "HEAD");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
