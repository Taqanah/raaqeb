import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import type { Heartbeat } from "@/shared/schemas/heartbeat.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { HeartbeatPanel } from "./heartbeat-parts.tsx";

const url = "https://status.example.test/api/heartbeat/abcdefghijklmnop";
const clock = {
  calendar: "gregorian",
  clock: "24h",
  timeZone: "UTC",
} as const;

function panel(recent: readonly Heartbeat[] = []): string {
  return renderToString(
    <MessagesProvider i18n={createMessages("en", en)}>
      <HeartbeatPanel
        clock={clock}
        heartbeat={{ last: recent[0], recent, url }}
      />
    </MessagesProvider>
  );
}

const ran: Heartbeat = {
  arrivedAt: Date.UTC(2026, 9, 19, 2, 30),
  failure: undefined,
  sourceIp: "203.0.113.7",
};
const failed: Heartbeat = {
  arrivedAt: Date.UTC(2026, 9, 19, 2, 40),
  failure: { exitCode: 2, message: "dump failed: disk full" },
  sourceIp: undefined,
};

describe("the heartbeat panel", () => {
  test("the URL, the line a job runs and the line it runs when it fails each come with a button that copies them", () => {
    const html = panel();
    expect(html.match(/data-slot="copy"/g)?.length).toBe(3);
    expect(html).toContain('data-copy="heartbeat-url"');
    expect(html).toContain('data-copy="heartbeat-command"');
    expect(html).toContain('data-copy="heartbeat-fail-command"');
    expect(html).toContain(`${url}/fail`);
  });

  test("says no heartbeat has arrived while the list is empty", () => {
    const html = panel();
    expect(html).toContain("No heartbeat has arrived yet.");
    expect(html).not.toContain('data-slot="heartbeats"');
  });

  test("lists the latest heartbeats, newest first, a failure with its exit code and message and a success with neither", () => {
    const html = panel([failed, ran]);
    expect(html).toContain('data-slot="heartbeats"');
    expect(html.match(/<li/g)).toHaveLength(2);
    // The failure leads, so it is the one the page names as the last.
    expect(html.indexOf("dump failed: disk full")).toBeLessThan(
      html.indexOf("203.0.113.7")
    );
    expect(html).toContain("Failed");
    expect(html).toContain("Succeeded");
    expect(html).toContain("Exit code");
    expect(html).toContain("dump failed: disk full");
    expect(html.match(/data-failed=""/g)).toHaveLength(1);
    expect(html.match(/data-slot="last-heartbeat"/g)).toHaveLength(1);
  });

  test("a failure with no exit code shows none", () => {
    const html = panel([
      {
        ...failed,
        failure: { exitCode: undefined, message: undefined },
      },
    ]);
    expect(html).toContain("Failed");
    expect(html).not.toContain("Exit code");
  });
});
