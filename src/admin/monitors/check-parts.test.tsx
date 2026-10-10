import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { formatUnit } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import {
  CapturedResponse,
  FailureDetail,
  formatResponseTime,
  printableBody,
} from "./check-parts.tsx";

function render(locale: Locale, node: ReactNode): string {
  return renderToString(
    <MessagesProvider i18n={createMessages(locale, locale === "ar" ? ar : en)}>
      {node}
    </MessagesProvider>
  );
}

const latinUnit = /\d ms/;

const slow = (
  <FailureDetail
    failure={{
      error: undefined,
      params: { limitMs: 3000, observedMs: 3500, reason: "slow" },
    }}
  />
);

describe("the failure detail of a slow check", () => {
  for (const locale of ["ar", "en"] as const) {
    test(`shows the limit and the response time in the ${locale} millisecond unit`, () => {
      const html = render(locale, slow);
      expect(html).toContain(formatUnit(locale, 3000, "millisecond"));
      expect(html).toContain(formatUnit(locale, 3500, "millisecond"));
    });
  }

  test("writes no Latin unit in Arabic", () => {
    expect(render("ar", slow)).not.toMatch(latinUnit);
  });

  test("leaves the less-than sign in the line's direction, so Arabic mirrors it and it still reads less than", () => {
    const html = render("ar", slow);
    expect(html).not.toContain('dir="ltr">&lt;');
    expect(html).toContain(
      `>&lt; <!-- -->${formatUnit("ar", 3000, "millisecond")}</dd>`
    );
  });
});

describe("the failure detail of an unexpected status", () => {
  test("keeps the expected and observed codes as machine tokens", () => {
    const html = render(
      "ar",
      <FailureDetail
        failure={{
          error: undefined,
          params: {
            expected: ["2xx", "301"],
            observed: 503,
            reason: "unexpected_status",
          },
        }}
      />
    );
    expect(html).toContain('data-slot="token" dir="ltr">2xx, 301</bdi>');
    expect(html).toContain('data-slot="token" dir="ltr">503</bdi>');
  });
});

describe("the failure detail of a refused connection", () => {
  const refused = (host: string, port: number) => (
    <FailureDetail
      failure={{
        error: undefined,
        params: { host, port, reason: "connection_refused" },
      }}
    />
  );

  for (const locale of ["ar", "en"] as const) {
    test(`shows the host and port it tried as a machine token in ${locale}`, () => {
      expect(render(locale, refused("mail.example.test", 587))).toContain(
        'data-slot="token" dir="ltr">mail.example.test:587</bdi>'
      );
    });
  }

  test("writes an IPv6 host in brackets, as the monitor's target does", () => {
    expect(render("en", refused("2001:db8::1", 5432))).toContain(
      'dir="ltr">[2001:db8::1]:5432</bdi>'
    );
  });

  test("does not bracket a host that arrives bracketed from a URL", () => {
    expect(render("en", refused("[::1]", 8080))).toContain(
      'dir="ltr">[::1]:8080</bdi>'
    );
  });
});

describe("the failure detail of a DNS lookup that failed", () => {
  test("shows the name it looked up as a machine token", () => {
    const html = render(
      "ar",
      <FailureDetail
        failure={{
          error: undefined,
          params: { host: "_dmarc.example.test", reason: "dns_failed" },
        }}
      />
    );
    expect(html).toContain(
      'data-slot="token" dir="ltr">_dmarc.example.test</bdi>'
    );
  });
});

describe("the failure detail of a container that is not running", () => {
  test("shows Docker's state and the exit code as Docker writes them, a machine token", () => {
    const html = render(
      "ar",
      <FailureDetail
        failure={{
          error: undefined,
          params: {
            exitCode: 137,
            reason: "container_not_running",
            state: "exited",
          },
        }}
      />
    );
    expect(html).toContain('data-slot="token" dir="ltr">exited (137)</bdi>');
  });

  test("shows a container that never ran by its state alone, with no exit code", () => {
    const html = render(
      "en",
      <FailureDetail
        failure={{
          error: undefined,
          params: {
            exitCode: 0,
            reason: "container_not_running",
            state: "created",
          },
        }}
      />
    );
    expect(html).toContain('data-slot="token" dir="ltr">created</bdi>');
  });

  test("shows a restarting container's last exit code the same way", () => {
    const html = render(
      "en",
      <FailureDetail
        failure={{
          error: undefined,
          params: { exitCode: 1, reason: "container_restarting" },
        }}
      />
    );
    expect(html).toContain('data-slot="token" dir="ltr">restarting (1)</bdi>');
  });
});

describe("a check's response time", () => {
  test("under 1 ms reads less than 1 ms, never 0, in each locale", () => {
    expect(formatResponseTime("ar", 0)).toBe("< 1 ملي ث");
    expect(formatResponseTime("en", 0)).toBe("< 1 ms");
    expect(formatResponseTime("en", 0.4)).toBe("< 1 ms");
  });

  test("1 ms and over is the plain millisecond unit", () => {
    for (const locale of ["ar", "en"] as const) {
      for (const ms of [1, 245, 10_000]) {
        expect(formatResponseTime(locale, ms)).toBe(
          formatUnit(locale, ms, "millisecond")
        );
      }
    }
  });
});

describe("a capture's body in the view", () => {
  const replacement = "\uFFFD";

  test("a C0 control character shows as the replacement character", () => {
    expect(printableBody("\b\u0002\u0012ARejection([MethodNotAllowed])")).toBe(
      `${replacement.repeat(3)}ARejection([MethodNotAllowed])`
    );
    expect(printableBody("\u0000\u000B\u000C\u001B\u001F")).toBe(
      replacement.repeat(5)
    );
  });

  test("printable text in any script is left alone", () => {
    const text = '{"حالة":"تعمل"} \u00A0é ✓ 😀 ~';
    expect(printableBody(text)).toBe(text);
  });

  test("each edge of the ranges falls on the right side", () => {
    const replaced = [0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f, 0x80, 0x9f];
    const kept = [0x09, 0x0a, 0x0d, 0x20, 0x7e, 0xa0];
    for (const point of replaced) {
      expect(printableBody(String.fromCodePoint(point))).toBe("\uFFFD");
    }
    for (const point of kept) {
      const text = String.fromCodePoint(point);
      expect(printableBody(text)).toBe(text);
    }
  });

  test("the capture view shows the body in its printable form", () => {
    const html = render(
      "en",
      <CapturedResponse response={{ body: "\b\u0002ok\u0085", headers: [] }} />
    );
    expect(html).toContain(`${replacement}${replacement}ok${replacement}`);
    expect(html).not.toContain("\b");
  });
});
