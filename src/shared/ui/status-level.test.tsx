import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge, type BadgeVariant, PageStatusColours } from "./badge.tsx";
import { pageColourVariants } from "./status-level.tsx";

function onPage(own: ReadonlySet<BadgeVariant>, badge: ReactNode): string {
  return renderToStaticMarkup(
    <PageStatusColours value={own}>{badge}</PageStatusColours>
  );
}

/** The mark's opening tag, its attributes in any order. */
const markElement = /<svg[^>]*data-slot="badge-mark"[^>]*>/;
/** The degraded fill itself, not its soft tint or its text token. */
const degradedFill = /\btext-status-degraded(?![\w-])/;

describe("a status page's own status colours on its badges", () => {
  test("each level the page picked a colour for names its badge's variant; the levels it left name none", () => {
    expect(
      pageColourVariants({
        degraded_performance: "#eab308",
        major_outage: "#7f1d1d",
        operational: "#22c55e",
        partial_outage: "#f97316",
        under_maintenance: "#a855f7",
      })
    ).toEqual(new Set(["degraded", "down", "up", "partial", "maintenance"]));
    expect(pageColourVariants({ major_outage: "#7f1d1d" })).toEqual(
      new Set(["down"])
    );
    expect(pageColourVariants({})).toEqual(new Set());
  });

  test("a badge whose colour the page picked shows it on its mark alone, the word in ink", () => {
    const html = onPage(
      new Set(["degraded"]),
      <Badge variant="degraded">Degraded</Badge>
    );
    const mark = html.match(markElement)?.[0];
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).toMatch(degradedFill);
    expect(html).toContain("text-foreground");
    expect(html).not.toContain("text-status-degraded-text");
    expect(html).toEndWith("Degraded</span>");
    expect(html).toContain('data-variant="degraded"');
  });

  test("a badge whose colour the page left shows its mark and its word in the level's dark text", () => {
    const html = onPage(
      new Set(["degraded"]),
      <Badge variant="down">Down</Badge>
    );
    expect(html).toMatch(markElement);
    expect(html).toContain("text-status-down-text");
  });

  test("a status badge is its mark and the bare word, on no tint", () => {
    const html = renderToStaticMarkup(
      <Badge variant="degraded">Degraded</Badge>
    );
    expect(html).toMatch(markElement);
    expect(html).not.toContain("bg-status-degraded-soft");
    expect(html).toContain("text-status-degraded-text");
  });

  test("a badge that carries no status colour has no mark and no fill", () => {
    const html = onPage(
      new Set<BadgeVariant>(["secondary", "default"]),
      <Badge variant="secondary">Investigating</Badge>
    );
    expect(html).not.toMatch(markElement);
    expect(html).not.toContain("bg-subtle");
  });
});
