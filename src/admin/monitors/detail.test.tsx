import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import type { Check } from "@/shared/schemas/check.ts";
import type { MonitorDetail } from "@/shared/schemas/detail.ts";
import type { CaptureMode } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { MonitorDetailView, UptimeHover } from "./detail.tsx";

const now = 1_700_000_000_000;
const minute = 60_000;

function check(result: Check["result"], startedAt: number): Check {
  return {
    attempts: 1,
    bytes: 10,
    monitorId: "m",
    reason: result === "down" ? reasons.timeout : reasons.ok,
    responseMs: 100,
    result,
    startedAt,
    statusCode: 200,
  };
}

function detail(captureMode: CaptureMode): MonitorDetail {
  return {
    certificate: undefined,
    chart: undefined,
    covered: false,
    days: [],
    heartbeat: undefined,
    monitor: {
      config: {
        assertions: [{ codes: ["2xx"], kind: "status" }],
        captureMode,
        followRedirects: true,
        ignoreTlsErrors: false,
        method: "GET",
        type: "http",
        url: "https://example.test/",
      },
      createdAt: now - 60 * minute,
      id: "m",
      intervalMs: minute,
      name: "Site",
      paused: false,
      retries: 0,
      channels: [],
      events: [...monitorEventKinds],
      tags: [],
      target: "https://example.test/",
      timeoutMs: 10_000,
      updatedAt: now - 60 * minute,
    },
    now,
    outages: [
      {
        endedAt: undefined,
        monitorId: "m",
        reason: reasons.timeout,
        startedAt: now - 3 * minute,
      },
    ],
    outagesTotal: 1,
    recent: [check("down", now - minute), check("up", now - 2 * minute)],
    spanChecks: {
      checks: [check("down", now - minute), check("up", now - 2 * minute)],
      from: now - 30 * 1440 * minute,
      kept: true,
      more: false,
    },
    state: "down",
    uptime: [],
  };
}

function render(locale: Locale, node: React.ReactNode): string {
  return renderToString(
    <MessagesProvider i18n={createMessages(locale, locale === "ar" ? ar : en)}>
      {node}
    </MessagesProvider>
  );
}

const clock = {
  calendar: "gregorian",
  clock: "24h",
  timeZone: "UTC",
} as const;
const noRange = () => undefined;
const noRecord = () =>
  Promise.resolve({ ok: false, reason: "unavailable" } as const);

function page(locale: Locale, captureMode: CaptureMode): string {
  return render(
    locale,
    <MonitorDetailView
      clock={clock}
      detail={detail(captureMode)}
      onRange={noRange}
      openRecord={noRecord}
    />
  );
}

const detailsButton = /data-slot="check-details"/g;

describe("the recent checks open to what a check kept", () => {
  test("with capture always, an up check opens too, since it kept its response", () => {
    expect(page("en", "always").match(detailsButton)).toHaveLength(2);
  });

  test("otherwise only a down check opens", () => {
    expect(page("en", "on_failure").match(detailsButton)).toHaveLength(1);
    expect(page("en", "off").match(detailsButton)).toHaveLength(1);
  });
});

describe("the detail's state", () => {
  test("a monitor with no check yet waits for its first check in the header too", () => {
    const html = render(
      "en",
      <MonitorDetailView
        clock={clock}
        detail={{ ...detail("off"), recent: [], state: undefined }}
        onRange={noRange}
        openRecord={noRecord}
      />
    );
    expect(html).toContain('data-slot="monitor-waiting"');
  });

  test("a heartbeat monitor that heard a heartbeat before its first check waits for its first check, not its first heartbeat", () => {
    const base = detail("off");
    const html = render(
      "en",
      <MonitorDetailView
        clock={clock}
        detail={{
          ...base,
          heartbeat: {
            last: { arrivedAt: now - minute, sourceIp: undefined },
            url: "https://status.example.test/api/heartbeat/abc",
          },
          monitor: {
            ...base.monitor,
            config: {
              schedule: { expression: "30 2 * * *", kind: "cron" },
              type: "heartbeat",
            },
            target: undefined,
          },
          outages: [],
          outagesTotal: 0,
          recent: [],
          state: undefined,
        }}
        onRange={noRange}
        openRecord={noRecord}
      />
    );
    expect(html).toContain("Waiting for first check");
    expect(html).not.toContain("Waiting for first heartbeat");
  });
});

describe("sentences come whole from the catalog", () => {
  test("the last check is one message with the time in it", () => {
    expect(page("en", "off")).toContain("Last check: 1 minute ago");
    expect(page("ar", "off")).toContain("آخر فحص: قبل دقيقة واحدة");
  });

  test("an ongoing outage says how long it has lasted in one message", () => {
    expect(page("en", "off")).toContain("Ongoing for 3 min");
  });
});

describe("an acknowledged outage", () => {
  function outages(acknowledgedAt: number | undefined): string {
    const base = detail("off");
    const [open] = base.outages;
    if (!open) {
      throw new Error("no outage");
    }
    return render(
      "en",
      <MonitorDetailView
        clock={clock}
        detail={{ ...base, outages: [{ ...open, acknowledgedAt }] }}
        onRange={noRange}
        openRecord={noRecord}
      />
    );
  }

  test("shows when it was acknowledged on its row", () => {
    const html = outages(now - minute);
    expect(html).toContain('data-slot="outage-acknowledged"');
    expect(html).toContain(
      `dateTime="${new Date(now - minute).toISOString()}"`
    );
  });

  test("an outage nobody acknowledged shows none", () => {
    expect(outages(undefined)).not.toContain("outage-acknowledged");
  });
});

describe("the uptime hover", () => {
  test("shows the exact downtime in seconds, its fraction kept", () => {
    const html = render(
      "en",
      <UptimeHover
        reading={{ downtimeMs: 61_400, observedMs: 3_600_000, window: "24h" }}
      />
    );
    expect(html).toContain("61.4 sec");
  });
});

describe("the recent checks' response time", () => {
  test("a check under 1 ms reads less than 1 ms, not 0 ms", () => {
    const recent = [{ ...check("up", now - minute), responseMs: 0 }];
    const html = render(
      "en",
      <MonitorDetailView
        clock={clock}
        detail={{
          ...detail("off"),
          recent,
          spanChecks: { checks: recent, from: 0, kept: true, more: false },
        }}
        onRange={noRange}
        openRecord={noRecord}
      />
    );
    expect(html).toContain("&lt; 1 ms");
    expect(html).not.toContain(">0 ms<");
  });
});

const hijriCell = /aria-label="[^"]*1445 AH[^"]*"[^>]*data-index="0"/;
const hijriOutage = /1445 AH, 22:10 \(UTC\)/;

describe("the operator's calendar", () => {
  test("names the day bar's days and the outages' times in Hijri", () => {
    const day = {
      date: "2023-11-14",
      downtimeMs: 0,
      incidents: [],
      maintenance: [],
      observedMs: 0,
      outages: [],
      responseMs: null,
      uptime: null,
    };
    const html = render(
      "en",
      <MonitorDetailView
        clock={{ ...clock, calendar: "hijri" }}
        detail={{ ...detail("off"), days: [day] }}
        onRange={noRange}
        openRecord={noRecord}
      />
    );
    expect(html).toMatch(hijriCell);
    expect(html).toMatch(hijriOutage);
  });
});

describe("the checks of a zoomed span", () => {
  const span = { from: now - 60 * minute, to: now - 30 * minute };
  const inSpan = [
    check("up", now - 31 * minute),
    check("down", now - 32 * minute),
  ];
  const noPage = () =>
    Promise.resolve({ ok: false, reason: "unavailable" } as const);

  function zoomed(spanChecks: MonitorDetail["spanChecks"]): string {
    return render(
      "en",
      <MonitorDetailView
        clock={clock}
        detail={{
          ...detail("off"),
          // The read zoomed the chart too, as it does for a span it lists.
          chart: {
            bucketMs: minute,
            buckets: [],
            from: span.from,
            gapLimitMs: 5 * minute,
            range: "24h",
            to: span.to,
          },
          spanChecks,
        }}
        onRange={noRange}
        openRecord={noRecord}
        readSpanChecks={noPage}
        zoom={span}
      />
    );
  }
  const rows = (html: string) =>
    [...html.matchAll(/data-check="(\d+)"/g)].map(([, at]) => Number(at));
  const showMore = 'data-slot="span-checks-more"';

  test("the list holds the span's checks instead of the newest, and offers more while older ones remain", () => {
    const html = zoomed({
      checks: inSpan,
      from: span.from,
      kept: true,
      more: true,
    });
    expect(rows(html)).toEqual(inSpan.map((each) => each.startedAt));
    expect(html).toContain(showMore);
  });

  test("each check of a span inside one day reads its clock time to the second, never a relative time", () => {
    const html = zoomed({
      checks: inSpan,
      from: span.from,
      kept: true,
      more: false,
    });
    // 31 minutes before now is 21:42:20 UTC on the operator's 24-hour clock.
    expect(html).toContain(">21:42:20<");
    expect(html).not.toContain("minutes ago");
  });

  test("once the span holds no older checks, the list offers no more", () => {
    expect(
      zoomed({ checks: inSpan, from: span.from, kept: true, more: false })
    ).not.toContain(showMore);
  });

  test("a span with no checks says so, not that none ran yet", () => {
    const html = zoomed({
      checks: [],
      from: span.from,
      kept: true,
      more: false,
    });
    expect(html).toContain('data-slot="span-checks-none"');
    expect(rows(html)).toEqual([]);
  });

  test("a span whose checks are no longer kept says only summaries remain, and lists no check", () => {
    const html = zoomed({ kept: false });
    expect(html).toContain('data-slot="span-checks-gone"');
    expect(rows(html)).toEqual([]);
    expect(html).not.toContain(showMore);
  });

  test("unzoomed, the list holds the newest checks in relative time, and offers more while older ones remain", () => {
    const html = render(
      "en",
      <MonitorDetailView
        clock={clock}
        detail={{
          ...detail("off"),
          spanChecks: {
            checks: detail("off").recent,
            from: 0,
            kept: true,
            more: true,
          },
        }}
        onRange={noRange}
        openRecord={noRecord}
        readSpanChecks={noPage}
      />
    );
    expect(rows(html)).toEqual(
      detail("off").recent.map((each) => each.startedAt)
    );
    expect(html).toContain("1 minute ago");
    expect(html).toContain(showMore);
  });
});
