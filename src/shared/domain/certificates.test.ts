import { describe, expect, test } from "bun:test";
import {
  certificateExpiresWithin,
  certificateWarningDue,
  daysLeft,
} from "./certificates.ts";

const day = 86_400_000;
const now = 1_700_000_000_000;

describe("the TLS expiry threshold", () => {
  test("a certificate expiring at the threshold or inside it is expiring", () => {
    expect(certificateExpiresWithin({ validTo: now + 14 * day }, 14, now)).toBe(
      true
    );
    expect(certificateExpiresWithin({ validTo: now + 3 * day }, 14, now)).toBe(
      true
    );
  });

  test("a certificate expiring one millisecond past the threshold is not", () => {
    expect(
      certificateExpiresWithin({ validTo: now + 14 * day + 1 }, 14, now)
    ).toBe(false);
  });

  test("an expired certificate is expiring at every threshold", () => {
    expect(certificateExpiresWithin({ validTo: now - day }, 1, now)).toBe(true);
  });
});

describe("the certificate warning due", () => {
  test("a certificate with more than its threshold left is owed no warning", () => {
    expect(
      certificateWarningDue({ validTo: now + 14 * day + 1 }, 14, now)
    ).toBeUndefined();
  });

  test("a certificate that crosses the threshold is owed the threshold's warning", () => {
    expect(certificateWarningDue({ validTo: now + 14 * day }, 14, now)).toBe(
      "threshold"
    );
    expect(certificateWarningDue({ validTo: now + 2 * day }, 14, now)).toBe(
      "threshold"
    );
  });

  test("a certificate with a day or less left, or already expired, is owed the last day's warning", () => {
    expect(certificateWarningDue({ validTo: now + day }, 14, now)).toBe(
      "last_day"
    );
    expect(
      certificateWarningDue(
        { validTo: now + day, warned: "threshold" },
        14,
        now
      )
    ).toBe("last_day");
    expect(certificateWarningDue({ validTo: now - day }, 14, now)).toBe(
      "last_day"
    );
  });

  test("each warning is owed once: a certificate that had it is owed nothing until the next", () => {
    expect(
      certificateWarningDue(
        { validTo: now + 3 * day, warned: "threshold" },
        14,
        now
      )
    ).toBeUndefined();
    expect(
      certificateWarningDue(
        { validTo: now + day / 2, warned: "last_day" },
        14,
        now
      )
    ).toBeUndefined();
  });

  test("a certificate that had the last day's warning is owed no threshold warning after it, even when the threshold grows", () => {
    expect(
      certificateWarningDue(
        { validTo: now + 20 * day, warned: "last_day" },
        30,
        now
      )
    ).toBeUndefined();
  });

  test("a threshold of one day gives the last day's warning alone", () => {
    expect(certificateWarningDue({ validTo: now + day }, 1, now)).toBe(
      "last_day"
    );
    expect(
      certificateWarningDue({ validTo: now + day + 1 }, 1, now)
    ).toBeUndefined();
  });
});

describe("the whole days a certificate has left", () => {
  test("are rounded down, and negative once it has expired", () => {
    expect(daysLeft(now + 14 * day, now)).toBe(14);
    expect(daysLeft(now + 14 * day - 1, now)).toBe(13);
    expect(daysLeft(now + day / 2, now)).toBe(0);
    expect(daysLeft(now - day / 2, now)).toBe(-1);
  });
});
