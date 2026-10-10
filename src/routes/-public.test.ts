import { describe, expect, test } from "bun:test";
import { september, viewIn } from "@/public/fixture.tsx";
import { historyHead } from "./-public.ts";

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
