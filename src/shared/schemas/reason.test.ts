import { describe, expect, test } from "bun:test";
import {
  reasonMessageId,
  reasonName,
  reasonNames,
  reasonParamsSchema,
  reasons,
} from "./reason.ts";

describe("the reason dictionary", () => {
  test("every reason has a code, numbered once and never renumbered", () => {
    expect(reasons).toEqual({
      ok: 0,
      timeout: 1,
      dns_failed: 2,
      connection_refused: 3,
      connection_failed: 4,
      certificate_expired: 5,
      certificate_invalid: 6,
      unexpected_status: 7,
      assertion_failed: 8,
      slow: 9,
      too_many_redirects: 10,
      heartbeat_late: 11,
      unknown: 12,
      dns_mismatch: 13,
      auth_failed: 14,
      query_failed: 15,
      container_not_found: 16,
      container_not_running: 17,
      container_restarting: 18,
      container_paused: 19,
      container_dead: 20,
      container_unhealthy: 21,
      tls_required: 22,
      smtp_no_greeting: 23,
      smtp_stalled: 24,
    });
  });

  test("codes are unique and fit one byte of a sealed day", () => {
    const codes = reasonNames.map((name) => reasons[name]);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => code >= 0 && code < 256)).toBe(true);
  });

  test("a stored code names its reason and an unknown code names nothing", () => {
    expect(reasonName(0)).toBe("ok");
    expect(reasonName(9)).toBe("slow");
    expect(reasonName(200)).toBeUndefined();
  });

  test("every reason renders through a catalog message in both locales", async () => {
    const root = `${import.meta.dir}/../../..`;
    const catalogs = await Promise.all(
      ["ar", "en"].map(async (locale) => ({
        locale,
        text: await Bun.file(`${root}/locales/${locale}/messages.po`).text(),
      }))
    );
    for (const { locale, text } of catalogs) {
      for (const name of reasonNames) {
        expect(
          text.includes(`msgid "${reasonMessageId(name)}"`),
          `${locale} lacks ${reasonMessageId(name)}`
        ).toBe(true);
      }
    }
  });

  test("the parameters of a reason parse from the failure detail's JSON", () => {
    expect(
      reasonParamsSchema.parse({
        expected: ["2xx"],
        observed: 503,
        reason: "unexpected_status",
      })
    ).toEqual({
      expected: ["2xx"],
      observed: 503,
      reason: "unexpected_status",
    });
    expect(
      reasonParamsSchema.safeParse({ reason: "slow", limitMs: 500 }).success
    ).toBe(false);
    expect(
      reasonParamsSchema.parse({
        expected: "192.0.2.1",
        observed: "192.0.2.2, 192.0.2.3",
        reason: "dns_mismatch",
      })
    ).toEqual({
      expected: "192.0.2.1",
      observed: "192.0.2.2, 192.0.2.3",
      reason: "dns_mismatch",
    });
    expect(
      reasonParamsSchema.safeParse({ reason: "later_reason" }).success
    ).toBe(false);
  });
});
