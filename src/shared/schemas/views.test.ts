import { describe, expect, test } from "bun:test";
import { feedUrl, viewPath } from "./overview.ts";
import { historyUrl, incidentUrl, maintenanceUrl } from "./views.ts";

describe("where a browser fetches a view's document", () => {
  test("the history, the current month's with none named", () => {
    expect(historyUrl("p-1")).toBe("/api/pages/p-1/history");
    expect(historyUrl("p-1", "2026-09")).toBe("/api/pages/p-1/history/2026-09");
  });

  test("an incident and a window, their ids escaped", () => {
    expect(incidentUrl("p 1", "i/1")).toBe("/api/pages/p%201/incidents/i%2F1");
    expect(maintenanceUrl("p-1", "w-1")).toBe("/api/pages/p-1/maintenance/w-1");
  });
});

describe("a view's path in a locale", () => {
  const main = { bases: { ar: "", en: "/en" }, origin: undefined };
  const api = {
    bases: { ar: "/status/api", en: "/en/status/api" },
    origin: undefined,
  };

  test("the overview is the page's plain address, the bare host as /", () => {
    expect(viewPath(main, "ar", "")).toBe("/");
    expect(viewPath(main, "en", "")).toBe("/en");
    expect(viewPath(api, "ar", "")).toBe("/status/api");
  });

  test("every other view hangs from it", () => {
    expect(viewPath(main, "ar", "/history")).toBe("/history");
    expect(viewPath(main, "en", "/incidents/i-1")).toBe("/en/incidents/i-1");
    expect(viewPath(api, "en", "/history/2026-09")).toBe(
      "/en/status/api/history/2026-09"
    );
  });
});

describe("the page's feed a feed reader is given", () => {
  const known = {
    bases: { ar: "", en: "/en" },
    origin: "https://status.example.test",
  };
  const api = {
    bases: { ar: "/status/api", en: "/en/status/api" },
    origin: "https://status.example.test",
  };

  test("is in the view's locale, absolute on the page's origin", () => {
    expect(feedUrl(known, "ar")).toBe("https://status.example.test/feed.atom");
    expect(feedUrl(known, "en")).toBe(
      "https://status.example.test/en/feed.atom"
    );
  });

  test("hangs from a page's own address under /status", () => {
    expect(feedUrl(api, "ar")).toBe(
      "https://status.example.test/status/api/feed.atom"
    );
    expect(feedUrl(api, "en")).toBe(
      "https://status.example.test/en/status/api/feed.atom"
    );
  });

  test("is the path alone when no public address is stored", () => {
    expect(feedUrl({ ...known, origin: undefined }, "en")).toBe(
      "/en/feed.atom"
    );
  });
});
