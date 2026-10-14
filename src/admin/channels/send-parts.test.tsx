import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import type { TimeOptions } from "@/shared/i18n/format.ts";
import { createMessages, type MessageId } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import type {
  Notification,
  NotificationPayload,
  SendFailure,
} from "@/shared/schemas/notification.ts";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { SendFailureText, SendRow, SendStatus } from "./send-parts.tsx";

const i18n = createMessages("ar", ar);
const clock: TimeOptions = {
  calendar: "gregorian",
  clock: "24h",
  timeZone: "Asia/Riyadh",
};
const at = 1_700_000_000_000;
const stamp = new Date(at).toISOString();
const monitor = {
  checkType: "http",
  id: "m",
  name: "الموقع",
  target: "https://example.test/",
} as const;

function render(node: ReactNode): string {
  return renderToString(
    <MessagesProvider i18n={i18n}>{node}</MessagesProvider>
  );
}

function sent(payload: NotificationPayload): Notification {
  return {
    attempts: 1,
    channelId: "c",
    failure: undefined,
    finishedAt: at,
    id: "n",
    kind: payload.type === "channel.test" ? "test" : "operator",
    nextAttemptAt: undefined,
    payload,
    queuedAt: at,
    status: "sent",
  };
}

const monitorEvents: readonly [NotificationPayload, MessageId][] = [
  [
    {
      data: { monitor, reason: "timeout" },
      timestamp: stamp,
      type: "monitor.down",
    },
    "monitor_event_down",
  ],
  [
    {
      data: { downtimeMs: 60_000, monitor },
      timestamp: stamp,
      type: "monitor.recovered",
    },
    "monitor_event_recovered",
  ],
  [
    {
      data: { monitor, reason: "slow" },
      timestamp: stamp,
      type: "monitor.degraded_started",
    },
    "monitor_event_degraded_started",
  ],
  [
    { data: { monitor }, timestamp: stamp, type: "monitor.degraded_ended" },
    "monitor_event_degraded_ended",
  ],
  [
    {
      data: { downForMs: 3_600_000, monitor, reason: "timeout" },
      timestamp: stamp,
      type: "monitor.reminder",
    },
    "monitor_field_reminder",
  ],
  [
    {
      data: { certificate: { daysLeft: 7, notAfter: stamp }, monitor },
      timestamp: stamp,
      type: "monitor.certificate_expiring",
    },
    "monitor_event_certificate_expiring",
  ],
];

describe("a channel's recent sends", () => {
  for (const [payload, label] of monitorEvents) {
    test(`show ${payload.type} by the label the monitor form gives its event, not by its id`, () => {
      const html = render(<SendRow clock={clock} send={sent(payload)} />);
      expect(html).toContain(i18n._(label));
      expect(html).not.toContain(payload.type);
    });
  }

  test("show a test send by its label alone, not by its id", () => {
    const html = render(
      <SendRow
        clock={clock}
        send={sent({
          data: { channel: { id: "c", name: "Ops" } },
          timestamp: stamp,
          type: "channel.test",
        })}
      />
    );
    expect(html).toContain(i18n._("channel_send_test_kind"));
    expect(html).not.toContain("channel.test");
  });
});

describe("a notification's state", () => {
  const timeout = {
    error: "timed out",
    params: { reason: "timeout", timeoutMs: 10_000 },
    reason: "timeout",
  } as const;

  test("reads waiting to send while it is queued and not yet tried, and keeps pending as its stored status", () => {
    const html = render(
      <SendStatus send={{ failure: undefined, status: "pending" }} />
    );
    expect(html).toContain(i18n._("channel_send_queued"));
    expect(html).not.toContain(i18n._("channel_send_pending"));
    expect(html).toContain('data-status="pending"');
  });

  test("reads waiting for retry only once an attempt failed", () => {
    const html = render(
      <SendStatus send={{ failure: timeout, status: "pending" }} />
    );
    expect(html).toContain(i18n._("channel_send_pending"));
    expect(html).not.toContain(i18n._("channel_send_queued"));
  });

  test("a sent and a failed notification read as such, and keep their stored status", () => {
    const sentHtml = render(
      <SendStatus send={{ failure: undefined, status: "sent" }} />
    );
    expect(sentHtml).toContain(i18n._("channel_send_sent"));
    expect(sentHtml).toContain('data-status="sent"');
    const failedHtml = render(
      <SendStatus send={{ failure: timeout, status: "failed" }} />
    );
    expect(failedHtml).toContain(i18n._("channel_send_failed"));
    expect(failedHtml).toContain('data-status="failed"');
  });

  test("a queued send in the recent sends reads waiting to send beside no attempts", () => {
    const html = render(
      <SendRow
        clock={clock}
        send={{
          ...sent({
            data: { channel: { id: "c", name: "Ops" } },
            timestamp: stamp,
            type: "channel.test",
          }),
          attempts: 0,
          finishedAt: undefined,
          nextAttemptAt: at,
          status: "pending",
        }}
      />
    );
    expect(html).toContain(i18n._("channel_send_queued"));
    expect(html).not.toContain(i18n._("channel_send_pending"));
  });
});

describe("a failure only the platform can explain", () => {
  const refused = (observed: number): SendFailure => ({
    error: '{"ok":false,"error_code":401,"description":"Unauthorized"}',
    params: { expected: ["2xx"], observed, reason: "unexpected_status" },
    reason: "unexpected_status",
  });
  const tokenRefused = i18n._("channel_telegram_token_refused");

  test("a Telegram send the Bot API refused with 401 or 404 says the bot token is not one Telegram knows", () => {
    for (const status of [401, 404]) {
      expect(
        render(
          <SendFailureText channelType="telegram" failure={refused(status)} />
        )
      ).toContain(tokenRefused);
    }
  });

  test("another status, or another channel's 401, says nothing of a bot token", () => {
    expect(
      render(<SendFailureText channelType="telegram" failure={refused(400)} />)
    ).not.toContain(tokenRefused);
    expect(
      render(<SendFailureText channelType="webhook" failure={refused(401)} />)
    ).not.toContain(tokenRefused);
  });

  test("a recent send of a Telegram channel says it too", () => {
    const html = render(
      <SendRow
        channelType="telegram"
        clock={clock}
        send={{
          ...sent({
            data: { channel: { id: "c", name: "Ops" } },
            timestamp: stamp,
            type: "channel.test",
          }),
          failure: refused(401),
          status: "failed",
        }}
      />
    );
    expect(html).toContain(tokenRefused);
  });
});
