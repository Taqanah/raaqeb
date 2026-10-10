import { describe, expect, test } from "bun:test";
import {
  subscribeInputSchema,
  subscriberEmailSchema,
  subscriberUrlSchema,
  subscriptionTokenOf,
} from "./subscription.ts";

describe("what a visitor may subscribe with", () => {
  test("an email address is trimmed and kept in lower case", () => {
    expect(subscriberEmailSchema.parse("  Reader@Example.TEST ")).toBe(
      "reader@example.test"
    );
  });

  test("text that is no email address, or one past 254 characters, is refused", () => {
    expect(subscriberEmailSchema.safeParse("reader").success).toBe(false);
    expect(subscriberEmailSchema.safeParse("").success).toBe(false);
    expect(
      subscriberEmailSchema.safeParse(`${"a".repeat(245)}@example.test`).success
    ).toBe(false);
  });

  test("a webhook is an https URL, kept as the URL parser writes it", () => {
    expect(
      subscriberUrlSchema.parse(" https://Hooks.Example.com/raaqeb?key=1 ")
    ).toBe("https://hooks.example.com/raaqeb?key=1");
  });

  test("plain http, a user name or password, text that is no URL, or one past 2048 characters is refused", () => {
    for (const text of [
      "http://hooks.example.com/raaqeb",
      "https://user:secret@hooks.example.com/",
      "https://user@hooks.example.com/",
      "hooks.example.com/raaqeb",
      `https://hooks.example.com/${"a".repeat(2048)}`,
    ]) {
      expect(subscriberUrlSchema.safeParse(text).success).toBe(false);
    }
  });

  test("the form's post names its channel, and the address must fit that channel", () => {
    const common = { locale: "ar" as const, pageId: "p1" };
    expect(
      subscribeInputSchema.safeParse({
        ...common,
        address: "reader@example.test",
        channel: "webhook",
      }).success
    ).toBe(false);
    expect(
      subscribeInputSchema.safeParse({
        ...common,
        address: "https://hooks.example.com/",
        channel: "email",
      }).success
    ).toBe(false);
    expect(
      subscribeInputSchema.parse({
        ...common,
        address: "Reader@Example.test",
        channel: "email",
      })
    ).toEqual({ ...common, address: "reader@example.test", channel: "email" });
    expect(
      subscribeInputSchema.safeParse({
        ...common,
        address: "reader@example.test",
        channel: "sms",
      }).success
    ).toBe(false);
  });
});

describe("a subscription page's address", () => {
  test("names its token, and no other path does", () => {
    expect(subscriptionTokenOf("/subscriptions/e2e-pending-token-0001")).toBe(
      "e2e-pending-token-0001"
    );
    for (const path of [
      "/subscriptions/e2e-pending-token-0001/confirm",
      "/subscriptions/short",
      "/subscriptions/",
      "/status/subscriptions/e2e-pending-token-0001",
      "/",
    ]) {
      expect(subscriptionTokenOf(path)).toBeUndefined();
    }
  });
});
