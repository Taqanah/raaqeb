import { describe, expect, test } from "bun:test";
import { notFound } from "@tanstack/react-router";
import { plainPage, september, viewIn } from "@/public/fixture.tsx";
import type {
  OverviewDocument,
  OverviewPage,
} from "@/shared/schemas/overview.ts";
import { messages as arabic } from "../../locales/ar/messages.ts";
import { messages as english } from "../../locales/en/messages.ts";
import { historyHead, missingHead, overviewHead } from "./-public.ts";

const raaqebIcon = {
  href: "/favicon.svg",
  rel: "icon",
  type: "image/svg+xml",
};

const own = { href: "/api/pages/p/favicon?h=abc", rel: "icon" };

describe("a history view's title", () => {
  test("names the month in the install's calendar before the page's title", () => {
    const head = historyHead(
      { document: september, view: viewIn("en") },
      undefined
    );
    expect(head.meta).toContainEqual({
      title: "Rabiʻ I – Rabiʻ II 1448 AH (September 2026) · Example status",
    });
  });
});

describe("a status page's favicon", () => {
  const view = viewIn("en");
  const documentOf = (page: OverviewPage): OverviewDocument => ({
    calendar: september.calendar,
    clock: september.clock,
    incidents: [],
    items: [],
    level: "operational",
    maintenance: [],
    page,
    subscribe: [],
    timeZone: september.timeZone,
  });

  test("falls back to Raaqeb's mark when the page has none", () => {
    const head = overviewHead(
      { document: documentOf(plainPage), view },
      undefined
    );
    expect(head.links).toContainEqual(raaqebIcon);
  });

  test("is the page's own when it has one, and Raaqeb's mark stays out", () => {
    const page = { ...plainPage, images: { favicon: own.href } };
    const head = overviewHead({ document: documentOf(page), view }, undefined);
    expect(head.links).toContainEqual(own);
    expect(head.links).not.toContainEqual(raaqebIcon);
  });
});

describe("a not-found view's favicon", () => {
  const notFoundOf = (page: typeof plainPage) =>
    notFound({
      data: {
        frame: {
          calendar: september.calendar,
          clock: september.clock,
          page,
          timeZone: september.timeZone,
        },
        view: viewIn("en"),
      },
    });

  test("falls back to Raaqeb's mark when the page has none", () => {
    expect(missingHead(notFoundOf(plainPage)).links).toContainEqual(raaqebIcon);
  });

  test("is the page's own when it has one", () => {
    const page = { ...plainPage, images: { favicon: own.href } };
    const { links } = missingHead(notFoundOf(page));
    expect(links).toContainEqual(own);
    expect(links).not.toContainEqual(raaqebIcon);
  });

  test("its title says the page is not found, in the document's words, before the page's title", () => {
    const rootIn = (locale: "ar" | "en") => ({
      catalog: JSON.stringify(locale === "ar" ? arabic : english),
      locale,
    });
    expect(
      missingHead(notFoundOf(plainPage), rootIn("en")).meta
    ).toContainEqual({ title: "Page not found · Example status" });
    expect(
      missingHead(notFoundOf(plainPage), rootIn("ar")).meta
    ).toContainEqual({ title: "الصفحة غير موجودة · Example status" });
  });
});

describe("a not-found view's title in the document's language", () => {
  test("names the page in that language when its frame names no view", () => {
    const page = {
      ...plainPage,
      locale: "ar" as const,
      title: { ar: "حالة المثال", en: "Example status" },
    };
    const error = notFound({
      data: {
        frame: {
          calendar: september.calendar,
          clock: september.clock,
          page,
          timeZone: september.timeZone,
        },
      },
    });
    const root = { catalog: JSON.stringify(english), locale: "en" };
    expect(missingHead(error, root).meta).toContainEqual({
      title: "Page not found · Example status",
    });
  });
});

describe("a status page's link preview", () => {
  const documentOf = (page: OverviewPage): OverviewDocument => ({
    calendar: september.calendar,
    clock: september.clock,
    incidents: [],
    items: [],
    level: "operational",
    maintenance: [],
    page,
    subscribe: [],
    timeZone: september.timeZone,
  });
  /** The overview's head for the page, served at the origin when one is known. */
  const headOf = (page: OverviewPage, origin: string | undefined) => {
    const view = viewIn("en");
    const { links = [], meta = [] } = overviewHead(
      {
        document: documentOf(page),
        view: { ...view, paths: { ...view.paths, origin } },
      },
      undefined
    );
    return { links, meta };
  };

  test("says it is a website at its absolute address, as the canonical link names it", () => {
    const { links, meta } = headOf(plainPage, "https://status.example.com");
    const canonical = links.find((link) => link.rel === "canonical")?.href;
    expect(canonical).toStartWith("https://status.example.com");
    expect(meta).toContainEqual({ content: "website", property: "og:type" });
    expect(meta).toContainEqual({
      content: canonical ?? "",
      property: "og:url",
    });
  });

  test("names no og:url when the page's origin is unknown, since it must be absolute", () => {
    const { meta } = headOf(plainPage, undefined);
    expect(meta.some((m) => "property" in m && m.property === "og:url")).toBe(
      false
    );
  });

  test("is a summary card without a cover and a large one with it", () => {
    const card = (page: OverviewPage) =>
      headOf(page, undefined).meta.filter(
        (m) => "name" in m && m.name === "twitter:card"
      );
    expect(card(plainPage)).toEqual([
      { content: "summary", name: "twitter:card" },
    ]);
    expect(
      card({ ...plainPage, images: { cover: "/api/pages/p/cover?h=1" } })
    ).toEqual([{ content: "summary_large_image", name: "twitter:card" }]);
  });
});
