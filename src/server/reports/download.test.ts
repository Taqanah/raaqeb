import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "@/server/pages/components.ts";
import {
  checksEvery,
  d0,
  day,
  hour,
  type PagesScratch,
  scratchPages,
  site,
} from "@/server/pages/fixture.ts";
import type { ReportQuery } from "@/shared/schemas/report.ts";
import { reportDownload } from "./download.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const now = d0 + 5 * day + 12 * hour;

function query(over: Partial<ReportQuery>): ReportQuery {
  return {
    from: "2026-09-01",
    id: "x",
    subject: "monitor",
    target: 99.9,
    to: "2026-09-03",
    ...over,
  };
}

describe("a report's download", () => {
  test("is a CSV file named by its days, in the operator's language", async () => {
    scratch = await scratchPages(d0);
    const { storage } = scratch;
    const monitor = await storage.monitors.create({
      ...site,
      intervalMs: hour,
      name: "الموقع",
    });
    await checksEvery(storage, monitor, d0, d0 + day, "up", hour);
    const download = await reportDownload(
      storage,
      query({ id: monitor.id }),
      now
    );
    expect(download.ok).toBe(true);
    if (download.ok) {
      expect(download.name).toBe(
        "raaqeb-report-monitor-2026-09-01-2026-09-03.csv"
      );
      expect(download.body.charCodeAt(0)).toBe(0xfe_ff);
      expect(download.body).toContain("نسبة التوفّر");
      expect(download.body).toContain("الموقع");
    }
  });

  test("takes the operator's language for its titles, and a component's name in it when it has one", async () => {
    scratch = await scratchPages(d0);
    const { storage } = scratch;
    const created = await createComponent(storage, {
      description: undefined,
      monitorIds: [],
      name: { ar: "الموقع", en: "Website" },
      status: "operational",
    });
    if (!created.ok) {
      throw new Error(created.reason);
    }
    const download = await reportDownload(
      storage,
      query({ id: created.component.id, subject: "component" }),
      now,
      { operatorLanguage: "en" }
    );
    expect(download.ok).toBe(true);
    if (download.ok) {
      expect(download.body).toContain("Uptime");
      expect(download.body).toContain("Website");
      expect(download.body).not.toContain("الموقع");
    }
  });

  test("is refused with the reason the report is", async () => {
    scratch = await scratchPages(d0);
    expect(
      await reportDownload(scratch.storage, query({ id: "nope" }), now)
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await reportDownload(
        scratch.storage,
        query({ from: "2026-09-09", to: "2026-09-01" }),
        now
      )
    ).toEqual({ ok: false, reason: "invalid" });
  });
});
