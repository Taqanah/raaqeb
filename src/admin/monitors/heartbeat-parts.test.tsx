import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { messages as en } from "../../../locales/en/messages.ts";
import { HeartbeatPanel } from "./heartbeat-parts.tsx";

const url = "https://status.example.test/api/heartbeat/abcdefghijklmnop";

function panel(): string {
  return renderToString(
    <MessagesProvider i18n={createMessages("en", en)}>
      <HeartbeatPanel clock={undefined} heartbeat={{ last: undefined, url }} />
    </MessagesProvider>
  );
}

describe("the heartbeat panel", () => {
  test("the URL and the line a job runs each come with a button that copies them", () => {
    const html = panel();
    expect(html.match(/data-slot="copy"/g)?.length).toBe(2);
    expect(html).toContain('data-copy="heartbeat-url"');
    expect(html).toContain('data-copy="heartbeat-command"');
  });
});
