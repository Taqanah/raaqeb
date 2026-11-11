import { describe, expect, test } from "bun:test";
import { reasons } from "@/shared/schemas/reason.ts";
import type {
  Report,
  ReportFigures,
  ReportLine,
} from "@/shared/schemas/report.ts";
import { type CsvWords, reportCsv, reportFileName } from "./csv.ts";

const minute = 60_000;
const hour = 60 * minute;
const d0 = Date.UTC(2026, 8, 1);

const words: CsvWords = {
  name: (name) => (typeof name === "string" ? name : (name.ar ?? "")),
  text: (id) => id,
};

const figures: ReportFigures = {
  acknowledgeMs: 10 * minute,
  degradedMs: 90 * minute,
  downtimeMs: 3 * hour,
  incidents: 1,
  maintenanceMs: 2 * hour,
  noDataMs: 0,
  observedMs: 70 * hour,
  outages: 2,
  recoveryMs: 90 * minute + 30_000,
};

function line(name: ReportLine["name"], over: Partial<ReportLine> = {}) {
  return {
    budget: {
      allowedMs: 252_000,
      leftMs: -10_548_000,
      met: false,
      usedRatio: 42.8,
    },
    figures,
    id: "id",
    name,
    uptime: { decimals: 2, percent: 95.71 },
    ...over,
  } satisfies ReportLine;
}

function report(over: Partial<Report> = {}): Report {
  return {
    from: "2026-09-01",
    madeAt: d0 + 10 * 24 * hour,
    members: [],
    open: false,
    subject: { ...line("alpha"), kind: "monitor" },
    target: 99.9,
    to: "2026-09-03",
    worst: [],
    ...over,
  };
}

/** The file's lines, the byte order mark and the last line end taken off. */
function linesOf(text: string): string[] {
  return text.slice(1, -2).split("\r\n");
}

describe("a report as CSV", () => {
  test("starts with a byte order mark so a spreadsheet reads Arabic, and ends every line with CRLF", () => {
    const text = reportCsv(report(), words);
    expect(text.charCodeAt(0)).toBe(0xfe_ff);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("the subject is one line under the titles, durations in minutes, uptime with its decimals and the days as UTC dates", () => {
    const [titles, subject] = linesOf(reportCsv(report(), words));
    expect(titles?.split(",")).toHaveLength(19);
    expect(titles).toContain("report_downtime (report_unit_minutes)");
    expect(subject).toBe(
      [
        "report_kind_monitor",
        "alpha",
        "2026-09-01",
        "2026-09-03",
        "99.9",
        "95.71",
        "report_missed",
        "180",
        "4200",
        "120",
        "0",
        "90",
        "4.2",
        "-175.8",
        "4280.0",
        "2",
        "1",
        "90.5",
        "10",
      ].join(",")
    );
  });

  test("a line with no uptime, no budget or no mean leaves those cells empty, never zero", () => {
    const empty = {
      budget: undefined,
      figures: {
        ...figures,
        acknowledgeMs: undefined,
        observedMs: 0,
        recoveryMs: undefined,
      },
      uptime: undefined,
    };
    const cells = linesOf(
      reportCsv(
        report({ subject: { ...line("alpha", empty), kind: "monitor" } }),
        words
      )
    )[1]?.split(",");
    expect(cells?.slice(5, 7)).toEqual(["", ""]);
    expect(cells?.[12]).toBe("");
    expect(cells?.[13]).toBe("");
    expect(cells?.[14]).toBe("");
    expect(cells?.slice(17)).toEqual(["", ""]);
  });

  test("a name with a comma, a quote or a line break is quoted, and one that would read as a formula is made harmless", () => {
    const lines = linesOf(
      reportCsv(
        report({
          members: [
            line('web, "main"'),
            line("=HYPERLINK(1)"),
            line("two\nlines"),
          ],
          subject: { ...line("alpha"), kind: "group" },
        }),
        words
      )
    );
    expect(lines[2]).toContain('"web, ""main"""');
    expect(lines[3]).toContain(",'=HYPERLINK(1),");
    expect(lines.join("\n")).toContain('"two\nlines"');
  });

  test("the members of a group follow the subject as monitors, those of a page as components", () => {
    const group = linesOf(
      reportCsv(
        report({
          members: [line("one")],
          subject: { ...line("core"), kind: "group" },
        }),
        words
      )
    );
    expect(group[1]).toStartWith("report_kind_group,core,");
    expect(group[2]).toStartWith("report_kind_monitor,one,");
    const page = linesOf(
      reportCsv(
        report({
          members: [line("web")],
          subject: { ...line("main"), kind: "page" },
        }),
        words
      )
    );
    expect(page[2]).toStartWith("report_kind_component,web,");
  });

  test("the worst outages come after a blank line, with their times in UTC and their reason", () => {
    const lines = linesOf(
      reportCsv(
        report({
          worst: [
            {
              acknowledgedAt: d0 + 10 * minute,
              downtimeMs: 2 * hour,
              endedAt: d0 + 2 * hour,
              monitorId: "m1",
              checkType: "http",
              monitorName: "alpha",
              reason: reasons.timeout,
              startedAt: d0,
            },
            {
              acknowledgedAt: undefined,
              downtimeMs: hour,
              endedAt: undefined,
              monitorId: "m1",
              checkType: "http",
              monitorName: "alpha",
              reason: reasons.timeout,
              startedAt: d0 + 5 * hour,
            },
          ],
        }),
        words
      )
    );
    expect(lines[2]).toBe("");
    expect(lines[4]).toBe(
      "alpha,2026-09-01T00:00:00.000Z,2026-09-01T02:00:00.000Z,120,reason_timeout,2026-09-01T00:10:00.000Z"
    );
    expect(lines[5]).toBe("alpha,2026-09-01T05:00:00.000Z,,60,reason_timeout,");
  });

  test("a report with no outage has no second table", () => {
    expect(linesOf(reportCsv(report(), words))).toHaveLength(2);
  });

  test("the file is named by what it is about and its days, never by a name that may hold any character", () => {
    expect(reportFileName(report())).toBe(
      "raaqeb-report-monitor-2026-09-01-2026-09-03.csv"
    );
  });
});
