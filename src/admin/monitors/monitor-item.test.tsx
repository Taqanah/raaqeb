import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import type { CheckResult } from "@/shared/schemas/check.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { StateBadge } from "./monitor-item.tsx";

const http: Monitor = {
  channels: [],
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url: "https://example.test/",
  },
  createdAt: 0,
  events: [...monitorEventKinds],
  id: "m",
  intervalMs: 60_000,
  name: "Site",
  paused: false,
  retries: 0,
  tags: [],
  target: "https://example.test/",
  timeoutMs: 10_000,
  updatedAt: 0,
};

const heartbeat: Monitor = {
  ...http,
  config: {
    graceMs: 900_000,
    schedule: { everyMs: 86_400_000, kind: "every" },
    type: "heartbeat",
  },
  target: undefined,
};

function badge(
  monitor: Monitor,
  state: CheckResult | undefined,
  heard = false
): string {
  return renderToString(
    <MessagesProvider i18n={createMessages("en", en)}>
      <StateBadge heard={heard} monitor={monitor} state={state} />
    </MessagesProvider>
  );
}

describe("a monitor's state badge", () => {
  test("a monitor with no check yet waits for its first check", () => {
    const html = badge(http, undefined);
    expect(html).toContain('data-slot="monitor-waiting"');
    expect(html).toContain("Waiting for first check");
  });

  test("a heartbeat monitor with no check yet waits for its first heartbeat", () => {
    const html = badge(heartbeat, undefined);
    expect(html).toContain('data-slot="monitor-waiting"');
    expect(html).toContain("Waiting for first heartbeat");
  });

  test("a heartbeat monitor that heard a heartbeat before its first check waits for its first check, never claiming no heartbeat came", () => {
    const html = badge(heartbeat, undefined, true);
    expect(html).toContain('data-slot="monitor-waiting"');
    expect(html).toContain("Waiting for first check");
    expect(html).not.toContain("Waiting for first heartbeat");
  });

  test("a paused monitor with no check yet shows paused, not waiting", () => {
    const html = badge({ ...heartbeat, paused: true }, undefined);
    expect(html).toContain('data-slot="monitor-paused"');
    expect(html).not.toContain("monitor-waiting");
  });

  test("a monitor that has a check shows its result, not waiting", () => {
    const html = badge(http, "down");
    expect(html).toContain('data-state="down"');
    expect(html).not.toContain("monitor-waiting");
  });
});
