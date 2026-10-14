import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { copies } from "~/copy.ts";
import { CodeLine } from "./section.tsx";
import { StatusPage } from "./status-page.tsx";

const cellName = /aria-label="([^"]+)"/;
const focusablePre = /<pre[^>]*tabindex="0"/;

/** Each day cell of the rendered bars, as its opening tag. */
function cells(html: string): string[] {
  return html.match(/<button[^>]*data-index="\d+"[^>]*>/g) ?? [];
}

describe("the sample status page's bars, to a screen reader and a keyboard", () => {
  for (const lang of ["ar", "en"] as const) {
    test(`every ${lang} day is named by its date and its state`, () => {
      const days = cells(renderToString(<StatusPage lang={lang} />));
      const states = Object.values(copies[lang].demo.levels);
      expect(days).toHaveLength(4 * 90);
      for (const day of days) {
        const name = day.match(cellName)?.[1] ?? "";
        expect(states.some((state) => name.endsWith(state))).toBe(true);
        expect(name.length).toBeGreaterThan(
          Math.max(...states.map((s) => s.length))
        );
      }
    });
  }

  test("each bar is one tab stop, today's day; the arrows reach the rest", () => {
    const days = cells(renderToString(<StatusPage lang="en" />));
    const stops = days.filter((day) => day.includes('tabindex="0"'));
    expect(stops).toHaveLength(4);
    for (const stop of stops) {
      expect(stop).toContain('data-index="89"');
    }
    expect(days.filter((day) => day.includes('tabindex="-1"'))).toHaveLength(
      4 * 89
    );
  });

  test("the incident and the maintenance window are headings one level under the section's", () => {
    const html = renderToString(<StatusPage lang="en" played={1} />);
    expect(html).not.toContain("<h4");
    expect(html.match(/<h3/g)).toHaveLength(2);
  });
});

test("a command too long for its line is a tab stop, so the keyboard scrolls it", () => {
  const html = renderToString(
    <CodeLine code="curl -fsSL https://example.com | sh" copied="" copy="" />
  );
  expect(html).toMatch(focusablePre);
});
