import { describe, expect, test } from "bun:test";
import { ssoFailureOf } from "./sso.ts";

describe("the sign-in page's reason for a refused sign-in through the provider", () => {
  test("names each code the callback comes back with, any other as a sign-in that did not finish, and none without one", () => {
    expect(ssoFailureOf(undefined)).toBeUndefined();
    expect(ssoFailureOf("")).toBeUndefined();
    expect(ssoFailureOf("NOT_INVITED")).toBe("not_invited");
    expect(ssoFailureOf("account_not_linked")).toBe("account_not_linked");
    expect(ssoFailureOf("EMAIL_NOT_VERIFIED")).toBe("account_not_linked");
    expect(ssoFailureOf("ACCOUNT_DEACTIVATED")).toBe("deactivated");
    expect(ssoFailureOf("state_mismatch")).toBe("failed");
  });
});
