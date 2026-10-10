import { describe, expect, test } from "bun:test";
import { clockSchema, timeZoneSchema } from "./clock.ts";
import {
  accountSettingsSchema,
  emailChangeSchema,
  generalSettingsSchema,
  passwordChangeSchema,
  storageSettingsSchema,
} from "./settings.ts";

describe("the clock format and time zone values", () => {
  test("the clock is 12h or 24h and nothing else", () => {
    expect(clockSchema.parse("12h")).toBe("12h");
    expect(clockSchema.parse("24h")).toBe("24h");
    expect(clockSchema.safeParse("12").success).toBe(false);
  });

  test("a time zone is an IANA name the runtime knows", () => {
    expect(timeZoneSchema.parse("Asia/Riyadh")).toBe("Asia/Riyadh");
    expect(timeZoneSchema.safeParse("Mars/Olympus").success).toBe(false);
  });
});

describe("what the general page posts", () => {
  test("carries the install language, zone, clock, calendar, public address and the release check switch", () => {
    const input = {
      calendar: "hijri",
      clock: "24h",
      installLanguage: "en",
      publicAddress: "https://status.example.test",
      releaseCheck: false,
      timeZone: "Asia/Riyadh",
    } as const;
    expect(generalSettingsSchema.parse(input)).toEqual(input);
  });

  test("refuses a public address that is not an origin and a clock outside the two", () => {
    expect(
      generalSettingsSchema.safeParse({
        clock: "24h",
        installLanguage: "en",
        publicAddress: "https://status.example.test/path",
        releaseCheck: true,
        timeZone: "Asia/Riyadh",
      }).success
    ).toBe(false);
    expect(
      generalSettingsSchema.safeParse({
        clock: "military",
        installLanguage: "en",
        publicAddress: "https://status.example.test",
        releaseCheck: true,
        timeZone: "Asia/Riyadh",
      }).success
    ).toBe(false);
  });
});

describe("what the account page posts", () => {
  test("every override is optional: an empty object means the operator follows the install", () => {
    expect(accountSettingsSchema.parse({})).toEqual({});
    expect(
      accountSettingsSchema.parse({ clock: "24h", operatorLanguage: "en" })
    ).toEqual({ clock: "24h", operatorLanguage: "en" });
  });

  test("an override outside its values is refused", () => {
    expect(
      accountSettingsSchema.safeParse({ operatorLanguage: "fr" }).success
    ).toBe(false);
    expect(
      accountSettingsSchema.safeParse({ timeZone: "Mars/Olympus" }).success
    ).toBe(false);
  });

  test("an email change is one address; a password change needs the current one and a new one of at least eight characters", () => {
    expect(emailChangeSchema.parse({ email: "op@example.com" })).toEqual({
      email: "op@example.com",
    });
    expect(emailChangeSchema.safeParse({ email: "op" }).success).toBe(false);
    expect(
      passwordChangeSchema.safeParse({
        currentPassword: "old password",
        newPassword: "short",
      }).success
    ).toBe(false);
    expect(
      passwordChangeSchema.safeParse({
        currentPassword: "",
        newPassword: "long enough password",
      }).success
    ).toBe(false);
    expect(
      passwordChangeSchema.parse({
        currentPassword: "old password",
        newPassword: "long enough password",
      })
    ).toEqual({
      currentPassword: "old password",
      newPassword: "long enough password",
    });
  });
});

describe("the storage page's input", () => {
  const mb = 1024 * 1024;

  test("carries the retention in days and the size budget in bytes; no budget means unlimited", () => {
    expect(
      storageSettingsSchema.parse({
        retentionDays: 90,
        sizeBudgetBytes: 500 * mb,
      })
    ).toEqual({ retentionDays: 90, sizeBudgetBytes: 500 * mb });
    expect(storageSettingsSchema.parse({ retentionDays: 3650 })).toEqual({
      retentionDays: 3650,
    });
  });

  test("refuses a retention outside 1 to 3650 days and a budget outside 64 MB to 1 TB", () => {
    for (const input of [
      { retentionDays: 0 },
      { retentionDays: 3651 },
      { retentionDays: 1.5 },
      { retentionDays: 90, sizeBudgetBytes: 64 * mb - 1 },
      { retentionDays: 90, sizeBudgetBytes: 1024 * 1024 * mb + 1 },
      { retentionDays: 90, sizeBudgetBytes: 100 * mb + 0.5 },
    ]) {
      expect(storageSettingsSchema.safeParse(input).success).toBe(false);
    }
  });
});
