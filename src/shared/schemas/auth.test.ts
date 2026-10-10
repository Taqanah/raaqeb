import { describe, expect, test } from "bun:test";
import { passwordMinLength, signInSchema } from "./auth.ts";

describe("the sign-in form's shape", () => {
  test("takes an email and a password of Better Auth's default minimum, 8, with no complexity rule", () => {
    expect(passwordMinLength).toBe(8);
    expect(
      signInSchema.safeParse({
        email: "operator@example.com",
        password: "12345678",
      }).success
    ).toBe(true);
    expect(
      signInSchema.safeParse({
        email: "operator@example.com",
        password: "1234567",
      }).success
    ).toBe(false);
    expect(
      signInSchema.safeParse({ email: "operator", password: "12345678" })
        .success
    ).toBe(false);
  });

  test("refuses a password over Better Auth's maximum of 128", () => {
    expect(
      signInSchema.safeParse({
        email: "operator@example.com",
        password: "x".repeat(129),
      }).success
    ).toBe(false);
  });
});
