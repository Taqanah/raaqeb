import { describe, expect, test } from "bun:test";
import {
  type MonitorEventKind,
  type MonitorFields,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import { eventApplies, notifies } from "./events.ts";

type Shape = Pick<MonitorFields, "config" | "degradedMs" | "events">;

const https = (tlsExpiryDays?: number): Shape["config"] => ({
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  type: "http",
  url: "https://api.example.test/health",
  ...(tlsExpiryDays === undefined ? {} : { tlsExpiryDays }),
});

const monitor = (overrides: Partial<Shape> = {}): Shape => ({
  config: https(),
  degradedMs: undefined,
  events: [...monitorEventKinds],
  ...overrides,
});

const applying = (shape: Shape): MonitorEventKind[] =>
  monitorEventKinds.filter((kind) => eventApplies(kind, shape));

describe("which monitor events can happen for a monitor", () => {
  test("down and recovered can happen for every monitor, whatever its check type", () => {
    const heartbeat = monitor({
      config: {
        schedule: { everyMs: 60_000, kind: "every" },
        type: "heartbeat",
      },
    });
    const tcp = monitor({
      config: { host: "db.example.test", port: 5432, type: "tcp" },
    });
    expect(applying(heartbeat)).toEqual(["down", "recovered"]);
    expect(applying(tcp)).toEqual(["down", "recovered"]);
  });

  test("the degraded pair can happen only with a response-time threshold", () => {
    expect(applying(monitor({ degradedMs: 800 }))).toEqual([
      "down",
      "recovered",
      "degraded_started",
      "degraded_ended",
    ]);
    expect(eventApplies("degraded_started", monitor())).toBe(false);
    expect(eventApplies("degraded_ended", monitor())).toBe(false);
  });

  test("certificate expiring can happen only for an https monitor with the expiry option on", () => {
    expect(
      eventApplies("certificate_expiring", monitor({ config: https(14) }))
    ).toBe(true);
    expect(eventApplies("certificate_expiring", monitor())).toBe(false);
    const plain = {
      ...https(14),
      url: "http://api.example.test/health",
    } as const;
    expect(
      eventApplies("certificate_expiring", monitor({ config: plain }))
    ).toBe(false);
  });
});

describe("which monitor events notify a monitor's channels", () => {
  test("an event switched on that can happen notifies", () => {
    expect(notifies(monitor(), "down")).toBe(true);
    expect(notifies(monitor({ degradedMs: 800 }), "degraded_started")).toBe(
      true
    );
  });

  test("an event switched off never notifies", () => {
    const quiet = monitor({ degradedMs: 800, events: ["recovered"] });
    expect(notifies(quiet, "down")).toBe(false);
    expect(notifies(quiet, "degraded_started")).toBe(false);
    expect(notifies(quiet, "recovered")).toBe(true);
  });

  test("an event switched on that cannot happen never notifies", () => {
    expect(notifies(monitor(), "degraded_ended")).toBe(false);
    expect(notifies(monitor(), "certificate_expiring")).toBe(false);
  });
});
