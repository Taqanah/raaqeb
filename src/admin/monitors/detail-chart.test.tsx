import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import type { ResponseSeries } from "@/shared/schemas/detail.ts";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { chartWidth } from "./chart.ts";
import { ResponseChart } from "./detail-chart.tsx";

const t0 = 1_700_000_000_000;
// The first line's path: the first point's x, then the third point's x.
const linePath = /<path[^>]* d="M([\d.]+) [\d.]+L[\d.]+ [\d.]+L([\d.]+) /;
const bucketMs = 300_000;
// A summary value shown as under 1 ms.
const summaryUnderOne = /&lt; 1 ms<\/dd>/g;

const series: ResponseSeries = {
  bucketMs,
  buckets: [0, 1, 2].map((index) => ({
    at: t0 + index * bucketMs,
    averageMs: 100 + index * 50,
    checks: 5,
    degraded: 0,
    down: 0,
    maxMs: 200,
    minMs: 100,
  })),
  from: t0,
  gapLimitMs: 120_000,
  range: "24h",
  to: t0 + 288 * bucketMs,
};

function drawn(locale: Locale): { first: number; last: number } {
  const html = renderToString(
    <MessagesProvider i18n={createMessages(locale, locale === "ar" ? ar : en)}>
      <ResponseChart
        clock={{ calendar: "gregorian", clock: "24h", timeZone: "UTC" }}
        degradedMs={undefined}
        series={series}
      />
    </MessagesProvider>
  );
  const path = linePath.exec(html);
  if (!path) {
    throw new Error("no line drawn");
  }
  return { first: Number(path[1]), last: Number(path[2]) };
}

describe("the response-time chart mirrors under both locales", () => {
  test("in Arabic the oldest point is at the right edge and time runs to the left", () => {
    const { first, last } = drawn("ar");
    expect(first).toBeGreaterThan(chartWidth / 2);
    expect(last).toBeLessThan(first);
  });

  test("in English the oldest point is at the left edge and time runs to the right", () => {
    const { first, last } = drawn("en");
    expect(first).toBeLessThan(chartWidth / 2);
    expect(last).toBeGreaterThan(first);
  });
});

describe("the response-time chart's summary", () => {
  test("a minimum under 1 ms reads less than 1 ms, not 0 ms", () => {
    const fast: ResponseSeries = {
      ...series,
      buckets: series.buckets.map((bucket) => ({ ...bucket, minMs: 0 })),
    };
    const html = renderToString(
      <MessagesProvider i18n={createMessages("en", en)}>
        <ResponseChart
          clock={{ calendar: "gregorian", clock: "24h", timeZone: "UTC" }}
          degradedMs={undefined}
          series={fast}
        />
      </MessagesProvider>
    );
    expect(html).toContain("&lt; 1 ms");
  });

  test("an average of half a millisecond reads less than 1 ms, as the recent checks do, not a rounded 1 ms", () => {
    const fast: ResponseSeries = {
      ...series,
      buckets: series.buckets.map((bucket) => ({
        ...bucket,
        averageMs: 0.5,
        maxMs: 0.6,
        minMs: 0.5,
      })),
    };
    const html = renderToString(
      <MessagesProvider i18n={createMessages("en", en)}>
        <ResponseChart
          clock={{ calendar: "gregorian", clock: "24h", timeZone: "UTC" }}
          degradedMs={undefined}
          series={fast}
        />
      </MessagesProvider>
    );
    expect(html.match(summaryUnderOne)).toHaveLength(3);
  });

  test("the axis keeps its zero tick as 0 ms: zero there is a scale, not a response time", () => {
    const html = renderToString(
      <MessagesProvider i18n={createMessages("en", en)}>
        <ResponseChart
          clock={{ calendar: "gregorian", clock: "24h", timeZone: "UTC" }}
          degradedMs={undefined}
          series={series}
        />
      </MessagesProvider>
    );
    expect(html).toContain(">0 ms</span>");
    expect(html).not.toContain("&lt; 1 ms");
  });
});

describe("the response-time chart's message when it has no response time", () => {
  function rendered(buckets: ResponseSeries["buckets"]): string {
    return renderToString(
      <MessagesProvider i18n={createMessages("en", en)}>
        <ResponseChart
          clock={{ calendar: "gregorian", clock: "24h", timeZone: "UTC" }}
          degradedMs={undefined}
          series={{ ...series, buckets }}
        />
      </MessagesProvider>
    );
  }

  test("a range whose checks are all down says every check failed, not that there were none, and keeps its down marks", () => {
    const html = rendered(
      series.buckets.map(({ at }) => ({
        at,
        averageMs: undefined,
        checks: 5,
        degraded: 0,
        down: 5,
        maxMs: undefined,
        minMs: undefined,
      }))
    );
    expect(html).toContain("Every check in this range failed.");
    expect(html).not.toContain("No checks in this range.");
    expect(html).toContain('data-slot="chart-down"');
  });

  test("a range with no check at all says there were no checks", () => {
    const html = rendered([]);
    expect(html).toContain("No checks in this range.");
    expect(html).not.toContain("Every check in this range failed.");
  });
});
