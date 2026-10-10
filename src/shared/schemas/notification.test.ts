import { describe, expect, test } from "bun:test";
import { notificationPayloadSchema } from "./notification.ts";

const monitor = {
  adminUrl: "https://status.example.test/admin/monitors/0199",
  checkType: "http",
  id: "0199",
  name: "الموقع",
  target: "https://example.test/",
};
const timestamp = "2026-09-25T10:00:00.000Z";

describe("a notification's payload", () => {
  test("each monitor event carries the monitor and what the event says", () => {
    const payloads = [
      { data: { monitor, reason: "timeout" }, timestamp, type: "monitor.down" },
      {
        data: { downtimeMs: 125_000, monitor },
        timestamp,
        type: "monitor.recovered",
      },
      {
        data: { monitor, reason: "slow" },
        timestamp,
        type: "monitor.degraded_started",
      },
      { data: { monitor }, timestamp, type: "monitor.degraded_ended" },
      {
        data: {
          certificate: { daysLeft: 13, notAfter: "2026-10-08T00:00:00.000Z" },
          monitor,
        },
        timestamp,
        type: "monitor.certificate_expiring",
      },
    ];
    for (const payload of payloads) {
      expect<unknown>(notificationPayloadSchema.parse(payload)).toEqual(
        payload
      );
    }
  });

  test("a test send names the channel", () => {
    const payload = {
      data: { channel: { id: "c1", name: "Ops" } },
      timestamp,
      type: "channel.test",
    };
    expect<unknown>(notificationPayloadSchema.parse(payload)).toEqual(payload);
  });

  test("a heartbeat monitor has no target and a monitor may have no admin link", () => {
    const { adminUrl: _, ...plain } = monitor;
    const payload = {
      data: {
        monitor: { ...plain, checkType: "heartbeat", target: null },
        reason: "heartbeat_late",
      },
      timestamp,
      type: "monitor.down",
    };
    expect(notificationPayloadSchema.safeParse(payload).success).toBe(true);
  });

  test("a reason is a name from the dictionary, never a number or free text", () => {
    for (const reason of [1, "the server is down"]) {
      expect(
        notificationPayloadSchema.safeParse({
          data: { monitor, reason },
          timestamp,
          type: "monitor.down",
        }).success
      ).toBe(false);
    }
  });

  test("the timestamp is ISO 8601 in UTC, and a type Raaqeb does not send is refused", () => {
    const down = { data: { monitor, reason: "timeout" }, type: "monitor.down" };
    expect(
      notificationPayloadSchema.safeParse({ ...down, timestamp: 1_700_000_000 })
        .success
    ).toBe(false);
    expect(
      notificationPayloadSchema.safeParse({
        ...down,
        timestamp: "2026-09-25T13:00:00+03:00",
      }).success
    ).toBe(false);
    expect(
      notificationPayloadSchema.safeParse({
        ...down,
        timestamp,
        type: "monitor.paused",
      }).success
    ).toBe(false);
  });
});
