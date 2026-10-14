import { describe, expect, test } from "bun:test";
import { render, september, viewIn } from "./fixture.tsx";
import { History } from "./views.tsx";

describe("a history view's month", () => {
  test("names the Hijri months the month spans, with the Gregorian month in brackets, in the install's calendar", () => {
    const html = render(
      "en",
      <History document={september} view={viewIn("en")} />
    );
    expect(html).toContain("Rabiʻ I – Rabiʻ II 1448 AH (September 2026)");
  });
});

const navTag = /<nav\b[^>]*>/g;

describe("a history view's landmarks", () => {
  test("every nav is named, the months' and the footer links' among them", () => {
    const page = {
      ...september.page,
      footerLinks: [{ label: { en: "Home" }, url: "https://example.com" }],
    };
    const html = render(
      "en",
      <History
        document={{ ...september, next: "2026-10", page, previous: "2026-08" }}
        view={viewIn("en")}
      />
    );
    const navs = html.match(navTag) ?? [];
    expect(navs.length).toBeGreaterThanOrEqual(3);
    for (const nav of navs) {
      expect(nav).toContain("aria-label=");
    }
  });
});
