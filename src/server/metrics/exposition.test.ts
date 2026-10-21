import { describe, expect, test } from "bun:test";
import { exposition, type MonitorSample } from "./exposition.ts";

const idle: MonitorSample = {
  certificateExpiresAt: undefined,
  checkedAt: undefined,
  checkType: "http",
  group: "",
  monitor: "Site",
  monitorId: "m1",
  paused: false,
  responseMs: undefined,
  state: undefined,
  uptime: undefined,
};

const labels = 'monitor="Site",monitor_id="m1",group="",check_type="http"';

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

describe("the text a scrape answers", () => {
  test("an up monitor is 1, not degraded, with its response time in seconds and its check time in epoch seconds", () => {
    const text = exposition("1.2.3", [
      {
        ...idle,
        checkedAt: 1_700_000_000_500,
        responseMs: 250,
        state: "up",
      },
    ]);
    expect(lines(text)).toContain(`raaqeb_monitor_up{${labels}} 1`);
    expect(lines(text)).toContain(`raaqeb_monitor_degraded{${labels}} 0`);
    expect(lines(text)).toContain(
      `raaqeb_monitor_response_seconds{${labels}} 0.25`
    );
    expect(lines(text)).toContain(
      `raaqeb_monitor_last_check_timestamp_seconds{${labels}} 1700000000.5`
    );
  });

  test("a degraded monitor is up and degraded; a down monitor is neither", () => {
    const degraded = lines(exposition("1", [{ ...idle, state: "degraded" }]));
    expect(degraded).toContain(`raaqeb_monitor_up{${labels}} 1`);
    expect(degraded).toContain(`raaqeb_monitor_degraded{${labels}} 1`);
    const down = lines(exposition("1", [{ ...idle, state: "down" }]));
    expect(down).toContain(`raaqeb_monitor_up{${labels}} 0`);
    expect(down).toContain(`raaqeb_monitor_degraded{${labels}} 0`);
  });

  test("a monitor with no check yet, or a check without a response time, has no sample for what it lacks", () => {
    const text = exposition("1", [idle]);
    expect(text).not.toContain("raaqeb_monitor_up{");
    expect(text).not.toContain("raaqeb_monitor_response_seconds");
    expect(text).not.toContain("raaqeb_monitor_last_check_timestamp_seconds");
    expect(text).toContain(`raaqeb_monitor_paused{${labels}} 0`);
  });

  test("a paused monitor says so and carries no state, though its latest check was down", () => {
    const text = exposition("1", [
      { ...idle, paused: true, responseMs: 90, state: "down" },
    ]);
    expect(text).toContain(`raaqeb_monitor_paused{${labels}} 1`);
    expect(text).not.toContain("raaqeb_monitor_up{");
    expect(text).not.toContain("raaqeb_monitor_degraded{");
    expect(text).not.toContain("raaqeb_monitor_response_seconds");
  });

  test("the uptime ratio is a gauge that names its window, and a paused monitor keeps the one it earned", () => {
    const text = exposition("1", [
      { ...idle, paused: true, uptime: 0.9166 },
      { ...idle, monitor: "Other", monitorId: "m2", uptime: 1 },
      { ...idle, monitor: "New", monitorId: "m3" },
    ]);
    const all = lines(text);
    expect(all).toContain(
      `raaqeb_monitor_uptime_ratio{${labels},window="7d"} 0.9166`
    );
    expect(all).toContain(
      'raaqeb_monitor_uptime_ratio{monitor="Other",monitor_id="m2",group="",check_type="http",window="7d"} 1'
    );
    // No observed time, no sample.
    expect(
      all.filter((line) => line.startsWith("raaqeb_monitor_uptime_ratio{"))
    ).toHaveLength(2);
    expect(all).toContain("# TYPE raaqeb_monitor_uptime_ratio gauge");
    expect(exposition("1", [idle])).not.toContain(
      "raaqeb_monitor_uptime_ratio"
    );
  });

  test("the certificate's expiry is in epoch seconds", () => {
    const text = exposition("1", [
      { ...idle, certificateExpiresAt: 1_800_000_000_000 },
    ]);
    expect(lines(text)).toContain(
      `raaqeb_certificate_expiry_timestamp_seconds{${labels}} 1800000000`
    );
  });

  test("labels carry the group and check type, and escape a backslash, a quote and a line break", () => {
    const text = exposition("1", [
      {
        ...idle,
        checkType: "postgres",
        group: "Core",
        monitor: 'a\\b "c"\nd',
        state: "up",
      },
    ]);
    expect(text).toContain(
      'raaqeb_monitor_up{monitor="a\\\\b \\"c\\"\\nd",monitor_id="m1",group="Core",check_type="postgres"} 1'
    );
  });

  test("two monitors with one name, group and check type are two series, told apart by their id", () => {
    const text = exposition("1", [
      { ...idle, monitorId: "m1", state: "up" },
      { ...idle, monitorId: "m2", state: "down" },
    ]);
    expect(lines(text)).toContain(
      'raaqeb_monitor_up{monitor="Site",monitor_id="m1",group="",check_type="http"} 1'
    );
    expect(lines(text)).toContain(
      'raaqeb_monitor_up{monitor="Site",monitor_id="m2",group="",check_type="http"} 0'
    );
  });

  test("every family opens with its help and its gauge type, once, and a family with no sample is left out", () => {
    const text = exposition("1", [
      { ...idle, state: "up" },
      { ...idle, monitor: "Other", state: "down" },
    ]);
    const all = lines(text);
    expect(
      all.filter((line) => line === "# TYPE raaqeb_monitor_up gauge")
    ).toHaveLength(1);
    expect(
      all.filter((line) => line.startsWith("# HELP raaqeb_monitor_up "))
    ).toHaveLength(1);
    expect(all.indexOf("# TYPE raaqeb_monitor_up gauge")).toBe(
      all.findIndex((line) => line.startsWith("# HELP raaqeb_monitor_up ")) + 1
    );
    expect(text).not.toContain("raaqeb_certificate_expiry_timestamp_seconds");
  });

  test("the build's version is a constant gauge, the text ends with a line break and an install with no monitors still answers", () => {
    const text = exposition("0.2.0", []);
    expect(lines(text)).toContain('raaqeb_build_info{version="0.2.0"} 1');
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("raaqeb_monitor_");
  });
});
