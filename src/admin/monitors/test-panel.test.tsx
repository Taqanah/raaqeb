import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { formatUnit } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import type { MonitorTest } from "@/shared/schemas/monitor.ts";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { TestPanel } from "./test-panel.tsx";

function render(locale: Locale, node: ReactNode): string {
  return renderToString(
    <MessagesProvider i18n={createMessages(locale, locale === "ar" ? ar : en)}>
      {node}
    </MessagesProvider>
  );
}

function ignore(): void {
  // The panel never runs a check in these tests.
}

describe("the test panel", () => {
  for (const locale of ["ar", "en"] as const) {
    test(`shows a response time assertion's limit in the ${locale} millisecond unit`, () => {
      const html = render(
        locale,
        <TestPanel
          onRun={ignore}
          state={{
            assertions: [{ kind: "response_time_under", ms: 3000 }],
            kind: "done",
            test: {
              bytes: 0,
              failure: undefined,
              reason: "ok",
              response: undefined,
              responseMs: 120,
              result: "up",
              statusCode: 200,
            },
          }}
        />
      );
      expect(html).toContain(formatUnit(locale, 3000, "millisecond"));
      expect(html).not.toContain("3000 ms");
    });
  }

  test("keeps a status assertion's codes as a machine token", () => {
    const html = render(
      "ar",
      <TestPanel
        onRun={ignore}
        state={{
          assertions: [{ codes: ["2xx"], kind: "status" }],
          kind: "done",
          test: {
            bytes: 0,
            failure: undefined,
            reason: "ok",
            response: undefined,
            responseMs: 120,
            result: "up",
            statusCode: 200,
          },
        }}
      />
    );
    expect(html).toContain('data-slot="token" dir="ltr">2xx</bdi>');
  });

  test("a result under 1 ms reads less than 1 ms, not 0 ms", () => {
    const html = render(
      "en",
      <TestPanel
        onRun={ignore}
        state={{
          assertions: [{ codes: ["2xx"], kind: "status" }],
          kind: "done",
          test: {
            bytes: 0,
            failure: undefined,
            reason: "ok",
            response: undefined,
            responseMs: 0,
            result: "up",
            statusCode: undefined,
          },
        }}
      />
    );
    expect(html).toContain("&lt; 1 ms");
    expect(html).not.toContain(">0 ms<");
  });

  test("a binary body in the capture shows its control characters as the replacement character", () => {
    const html = render(
      "en",
      <TestPanel
        onRun={ignore}
        state={{
          assertions: [{ codes: ["2xx"], kind: "status" }],
          kind: "done",
          test: {
            bytes: 4,
            failure: undefined,
            reason: "ok",
            response: { body: "\b\u0002ok", headers: [] },
            responseMs: 12,
            result: "up",
            statusCode: 405,
          },
        }}
      />
    );
    expect(html).toContain("\uFFFD\uFFFDok");
    expect(html).not.toContain("\u0002");
  });

  const dnsTest: MonitorTest = {
    bytes: 0,
    failure: undefined,
    reason: "ok",
    records: ["192.0.2.1", "v=spf1 -all"],
    response: undefined,
    responseMs: 8,
    result: "up",
    statusCode: undefined,
  };

  test("a DNS test lists each record the resolver answered as a machine token", () => {
    const html = render(
      "ar",
      <TestPanel
        onRun={ignore}
        state={{ assertions: [], kind: "done", test: dnsTest }}
      />
    );
    expect(html).toContain('data-slot="test-records"');
    expect(html).toContain('data-slot="token" dir="ltr">192.0.2.1</bdi>');
    expect(html).toContain('data-slot="token" dir="ltr">v=spf1 -all</bdi>');
  });

  test("a DNS mismatch lists the answered records beside the failure detail", () => {
    const html = render(
      "en",
      <TestPanel
        onRun={ignore}
        state={{
          assertions: [],
          kind: "done",
          test: {
            ...dnsTest,
            failure: {
              assertion: undefined,
              error: undefined,
              params: {
                expected: "192.0.2.9",
                observed: "192.0.2.1",
                reason: "dns_mismatch",
              },
            },
            reason: "dns_mismatch",
            records: ["192.0.2.1"],
            result: "down",
          },
        }}
      />
    );
    expect(html).toContain('data-slot="test-records"');
    expect(html).toContain('data-slot="token" dir="ltr">192.0.2.1</bdi>');
    expect(html).toContain('data-slot="token" dir="ltr">192.0.2.9</bdi>');
  });

  test("a TCP test shows the address it connected to as a machine token", () => {
    const html = render(
      "ar",
      <TestPanel
        onRun={ignore}
        state={{
          assertions: [],
          kind: "done",
          test: { ...dnsTest, address: "2001:db8::7", records: undefined },
        }}
      />
    );
    expect(html).toContain('data-slot="test-address"');
    expect(html).toContain('data-slot="token" dir="ltr">2001:db8::7</bdi>');
    expect(html).not.toContain('data-slot="test-records"');
  });

  test("a DNS test with no answers shows no record list", () => {
    const html = render(
      "en",
      <TestPanel
        onRun={ignore}
        state={{
          assertions: [],
          kind: "done",
          test: { ...dnsTest, records: [] },
        }}
      />
    );
    expect(html).not.toContain('data-slot="test-records"');
  });

  test("a database test shows the value its query answered as a machine token, and none when it has none", () => {
    const answered = render(
      "ar",
      <TestPanel
        onRun={ignore}
        state={{
          assertions: [],
          kind: "done",
          test: { ...dnsTest, answer: "ok", records: undefined },
        }}
      />
    );
    expect(answered).toContain('data-slot="test-answer"');
    expect(answered).toContain('data-slot="token" dir="ltr">ok</bdi>');
    const none = render(
      "ar",
      <TestPanel
        onRun={ignore}
        state={{
          assertions: [],
          kind: "done",
          test: { ...dnsTest, records: undefined },
        }}
      />
    );
    expect(none).not.toContain('data-slot="test-answer"');
  });
});
