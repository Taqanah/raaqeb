import { describe, expect, test } from "bun:test";
import type { TimeOptions } from "@/shared/i18n/format.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import type { ChannelPayload } from "./channel.ts";
import { chatText, clip, notificationText, plainText } from "./text.ts";

const monitor = {
  adminUrl: "https://status.example.test/admin/monitors/0199",
  checkType: "http" as const,
  id: "0199",
  name: "API",
  target: "https://api.example.test/health",
};
const timestamp = "2026-09-25T18:49:00.000Z";
const riyadh: TimeOptions = {
  calendar: "gregorian",
  clock: "12h",
  timeZone: "Asia/Riyadh",
};
const utc: TimeOptions = {
  calendar: "gregorian",
  clock: "24h",
  timeZone: "UTC",
};

const sent = (
  notification: NotificationPayload,
  locale: "ar" | "en" = "ar",
  time = riyadh
): ChannelPayload => ({ id: "n1", locale, notification, time });

const down: NotificationPayload = {
  data: { monitor, reason: "timeout" },
  timestamp,
  type: "monitor.down",
};

describe("a notification as text", () => {
  test("a down notification in Arabic is a sentence, then the monitor, its target, the reason in words and the time with its zone, and apart the monitor's link with its words and its line", async () => {
    expect(await notificationText(sent(down))).toEqual({
      lines: [
        "المراقبة: API",
        "الهدف: https://api.example.test/health",
        "العلة: انتهت مهلة الانتظار",
        "الوقت: 25 سبتمبر 2026، 9:49 م (غرينتش+3)",
      ],
      links: [
        {
          line: "الرابط: https://status.example.test/admin/monitors/0199",
          url: "https://status.example.test/admin/monitors/0199",
          words: "فتح المراقبة",
        },
      ],
      sentence: "المراقبة متعطّلة.",
      subject: "API: متعطّل",
    });
  });

  test("the time is written in the install's calendar, so an install can run in Hijri alone", async () => {
    const both = await notificationText(
      sent(down, "en", { ...utc, calendar: "hijri_gregorian" })
    );
    expect(both.lines).toContain(
      "Time: Rab. II 14, 1448 AH (Sep 25, 2026), 18:49 (UTC)"
    );
    const hijri = await notificationText(
      sent(down, "ar", { ...riyadh, calendar: "hijri" })
    );
    expect(hijri.lines).toContain(
      "الوقت: 14 ربيع الآخر 1448 هـ، 9:49 م (غرينتش+3)"
    );
  });

  test("a recovery in English says how long the outage lasted", async () => {
    expect(
      await notificationText(
        sent(
          {
            data: { downtimeMs: 754_000, monitor },
            timestamp,
            type: "monitor.recovered",
          },
          "en",
          utc
        )
      )
    ).toEqual({
      lines: [
        "Monitor: API",
        "Target: https://api.example.test/health",
        "Downtime: 12 min, 34 sec",
        "Time: Sep 25, 2026, 18:49 (UTC)",
      ],
      links: [
        {
          line: "Link: https://status.example.test/admin/monitors/0199",
          url: "https://status.example.test/admin/monitors/0199",
          words: "Open the monitor",
        },
      ],
      sentence: "The monitor is up again.",
      subject: "API is up again",
    });
  });

  test("a heartbeat monitor has no target line, and an install with no public address has no link line", async () => {
    const text = await notificationText(
      sent({
        data: {
          monitor: {
            checkType: "heartbeat",
            id: "0199",
            name: "النسخ الليلي",
            target: null,
          },
          reason: "heartbeat_late",
        },
        timestamp,
        type: "monitor.down",
      })
    );
    expect(text.lines.some((line) => line.startsWith("الهدف"))).toBe(false);
    expect(text.links).toEqual([]);
    expect(text.subject).toBe("النسخ الليلي: متعطّل");
  });

  test("degraded started names its reason, and degraded ended names none", async () => {
    const started = await notificationText(
      sent(
        {
          data: { monitor, reason: "slow" },
          timestamp,
          type: "monitor.degraded_started",
        },
        "en",
        utc
      )
    );
    expect(started.sentence).toBe("The monitor is degraded.");
    expect(started.lines).toContain("Reason: Slow response");
    const ended = await notificationText(
      sent(
        { data: { monitor }, timestamp, type: "monitor.degraded_ended" },
        "en",
        utc
      )
    );
    expect(ended.subject).toBe("API is no longer degraded");
    expect(ended.lines.some((line) => line.startsWith("Reason"))).toBe(false);
  });

  test("a certificate warning gives the time left and the expiry with its zone", async () => {
    const text = await notificationText(
      sent({
        data: {
          certificate: { daysLeft: 13, notAfter: "2026-10-08T12:00:00.000Z" },
          monitor,
        },
        timestamp,
        type: "monitor.certificate_expiring",
      })
    );
    expect(text.lines).toContain("المدة المتبقية: 13 يومًا");
    expect(text.lines).toContain("تنتهي في: 8 أكتوبر 2026، 3:00 م (غرينتش+3)");
  });

  test("a certificate with less than a day left gives the hours left, and an expired one no time left", async () => {
    const lastDay = await notificationText(
      sent({
        data: {
          certificate: { daysLeft: 0, notAfter: "2026-09-25T23:49:00.000Z" },
          monitor,
        },
        timestamp,
        type: "monitor.certificate_expiring",
      })
    );
    expect(lastDay.lines).toContain("المدة المتبقية: 5 س");
    const expired = await notificationText(
      sent({
        data: {
          certificate: { daysLeft: -1, notAfter: "2026-09-25T12:00:00.000Z" },
          monitor,
        },
        timestamp,
        type: "monitor.certificate_expiring",
      })
    );
    expect(
      expired.lines.some((line) => line.startsWith("المدة المتبقية"))
    ).toBe(false);
    expect(expired.lines).toContain(
      "تنتهي في: 25 سبتمبر 2026، 3:00 م (غرينتش+3)"
    );
  });

  test("a down notification with the open-incident link gives it its words and its line after the monitor's link", async () => {
    const text = await notificationText(
      sent({
        data: {
          incidentUrl:
            "https://status.example.test/admin/incidents/new?monitor=0199",
          monitor,
          reason: "timeout",
        },
        timestamp,
        type: "monitor.down",
      })
    );
    expect(text.links).toEqual([
      {
        line: "الرابط: https://status.example.test/admin/monitors/0199",
        url: "https://status.example.test/admin/monitors/0199",
        words: "فتح المراقبة",
      },
      {
        line: "فتح حادثة: https://status.example.test/admin/incidents/new?monitor=0199",
        url: "https://status.example.test/admin/incidents/new?monitor=0199",
        words: "فتح حادثة",
      },
    ]);
  });

  test("a reminder says the monitor is still down, why, and for how long so far", async () => {
    expect(
      await notificationText(
        sent({
          data: { downForMs: 7_200_000, monitor, reason: "timeout" },
          timestamp,
          type: "monitor.reminder",
        })
      )
    ).toEqual({
      lines: [
        "المراقبة: API",
        "الهدف: https://api.example.test/health",
        "العلة: انتهت مهلة الانتظار",
        "مدة التعطّل حتى الآن: 2 س",
        "الوقت: 25 سبتمبر 2026، 9:49 م (غرينتش+3)",
      ],
      links: [
        {
          line: "الرابط: https://status.example.test/admin/monitors/0199",
          url: "https://status.example.test/admin/monitors/0199",
          words: "فتح المراقبة",
        },
      ],
      sentence: "المراقبة ما زالت متعطّلة.",
      subject: "API: ما زال متعطّلًا",
    });
    const english = await notificationText(
      sent(
        {
          data: { downForMs: 5_400_000, monitor, reason: "timeout" },
          timestamp,
          type: "monitor.reminder",
        },
        "en",
        utc
      )
    );
    expect(english.subject).toBe("API is still down");
    expect(english.lines).toContain("Down for: 1 hr, 30 min");
  });

  test("a channel's test names the channel and the time", async () => {
    expect(
      await notificationText(
        sent(
          {
            data: { channel: { id: "c1", name: "Ops mail" } },
            timestamp,
            type: "channel.test",
          },
          "en",
          utc
        )
      )
    ).toEqual({
      lines: ["Channel: Ops mail", "Time: Sep 25, 2026, 18:49 (UTC)"],
      links: [],
      sentence:
        "This is a test message from Raaqeb. Its arrival means the channel works.",
      subject: "Test message from Raaqeb",
    });
  });
});

describe("a notification as a plain-text body", () => {
  test("the sentence, a blank line, then one line each", () => {
    expect(
      plainText({
        lines: ["المراقبة: API", "العلة: انتهت مهلة الانتظار"],
        links: [],
        sentence: "المراقبة متعطّلة.",
        subject: "API: متعطّل",
      })
    ).toBe("المراقبة متعطّلة.\n\nالمراقبة: API\nالعلة: انتهت مهلة الانتظار\n");
  });

  test("each link is its label-value line after the lines, since plain text cannot hold words that open a URL", () => {
    expect(
      plainText({
        lines: ["المراقبة: API"],
        links: [
          {
            line: "الرابط: https://status.example.test/admin/monitors/0199",
            url: "https://status.example.test/admin/monitors/0199",
            words: "فتح المراقبة",
          },
        ],
        sentence: "المراقبة متعطّلة.",
        subject: "API: متعطّل",
      })
    ).toBe(
      "المراقبة متعطّلة.\n\nالمراقبة: API\nالرابط: https://status.example.test/admin/monitors/0199\n"
    );
  });
});

describe("a notification as a chat message", () => {
  test("the subject, a blank line, then the plain-text body with no trailing line break", () => {
    const text = {
      lines: ["المراقبة: API", "العلة: انتهت مهلة الانتظار"],
      links: [],
      sentence: "المراقبة متعطّلة.",
      subject: "API: متعطّل",
    };
    expect(chatText(text)).toBe(
      "API: متعطّل\n\nالمراقبة متعطّلة.\n\nالمراقبة: API\nالعلة: انتهت مهلة الانتظار"
    );
  });

  test("the links are left out, for each chat channel to write in its own markup", () => {
    expect(
      chatText({
        lines: ["المراقبة: API"],
        links: [
          {
            line: "الرابط: https://status.example.test/admin/monitors/0199",
            url: "https://status.example.test/admin/monitors/0199",
            words: "فتح المراقبة",
          },
        ],
        sentence: "المراقبة متعطّلة.",
        subject: "API: متعطّل",
      })
    ).toBe("API: متعطّل\n\nالمراقبة متعطّلة.\n\nالمراقبة: API");
  });
});

describe("a message cut to a platform's limit", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length;

  test("a text within the limit is unchanged, even at the limit exactly", () => {
    expect(clip("المراقبة متعطّلة.", 100)).toBe("المراقبة متعطّلة.");
    expect(clip("x".repeat(20), 20)).toBe("x".repeat(20));
  });

  test("a longer text is cut to the limit and ends in an ellipsis", () => {
    const cut = clip("x".repeat(30), 20);
    expect(cut).toBe(`${"x".repeat(19)}…`);
    expect(cut.length).toBe(20);
  });

  test("the limit is counted by the measure given, such as UTF-8 bytes", () => {
    // An Arabic letter is two bytes and the ellipsis three.
    const cut = clip("م".repeat(100), 21, bytes);
    expect(cut).toBe(`${"م".repeat(9)}…`);
    expect(bytes(cut)).toBeLessThanOrEqual(21);
  });

  test("a cut never separates a letter from its mark, nor splits a flag", () => {
    expect(clip("مُمُمُ", 4)).toBe("مُ…");
    expect(clip("🇸🇦🇸🇦", 4)).toBe("…");
  });

  test("a cut never splits a character outside the basic plane", () => {
    const cut = clip("🔴".repeat(10), 6);
    expect(cut).toBe("🔴🔴…");
  });
});
