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
