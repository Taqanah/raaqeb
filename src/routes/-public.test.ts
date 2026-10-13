import { describe, expect, test } from "bun:test";
import { notFound } from "@tanstack/react-router";
import { plainPage, september, viewIn } from "@/public/fixture.tsx";
import type {
  OverviewDocument,
  OverviewPage,
} from "@/shared/schemas/overview.ts";
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
});
