import { describe, expect, test } from "bun:test";
import { runResult } from "./fixture.ts";
import {
  lastRow,
  type ReportData,
  reportDataId,
  reportHtml,
} from "./report.ts";
import { type HistoryRow, rowValues } from "./results.ts";

const viewer =
  '<!doctype html><html><head><title>Raaqeb floor</title></head><body><div id="root"></div><script type="module">boot()</script></body></html>';

const data: ReportData = {
  band: undefined,
  previous: undefined,
  result: runResult(),
  row: rowValues(runResult()),
};

/** The JSON written into a report, read back as the viewer reads it. */
function embedded(html: string): unknown {
  const start = html.indexOf(
    `<script type="application/json" id="${reportDataId}">`
  );
  const open = html.indexOf(">", start) + 1;
  const close = html.indexOf("</script>", open);
  return JSON.parse(html.slice(open, close));
}

describe("the report file", () => {
  test("carries the data as JSON the viewer reads back whole", () => {
    expect(embedded(reportHtml(viewer, data))).toEqual(
      JSON.parse(JSON.stringify(data))
    );
  });

  test("writes the data before the viewer's own scripts, so it is there when they run", () => {
    const html = reportHtml(viewer, data);
    expect(html.indexOf(reportDataId)).toBeLessThan(html.indexOf("boot()"));
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  test("a viewer with no head still carries the data first", () => {
    const html = reportHtml(
      '<div id="root"></div><script>boot()</script>',
      data
    );
    expect(
      html.startsWith(`<script type="application/json" id="${reportDataId}">`)
    ).toBe(true);
    expect(embedded(html)).toEqual(JSON.parse(JSON.stringify(data)));
  });

  test("a closing tag in the data cannot end the element early", () => {
    const tricky: ReportData = {
      ...data,
      result: runResult({ commit: "</script><script>alert(1)</script>" }),
    };
    const html = reportHtml(viewer, tricky);
    expect(html.split("</script>").length).toBe(
      viewer.split("</script>").length + 1
    );
    expect(embedded(html)).toMatchObject({
      result: { commit: "</script><script>alert(1)</script>" },
    });
  });
});

describe("the previous release in the history", () => {
  const row = (release: string): HistoryRow => ({
    ...rowValues(runResult()),
    commit: "abc",
    date: "2026-10-01",
    image: "raaqeb:0.1.0",
    release,
  });

  test("is the file's last row", () => {
    const text = `${JSON.stringify(row("0.1.0"))}\n${JSON.stringify(row("0.2.0"))}\n`;
    expect(lastRow(text)?.release).toBe("0.2.0");
  });

  test("an empty history has none", () => {
    expect(lastRow("")).toBeUndefined();
    expect(lastRow("\n\n")).toBeUndefined();
  });
});
