import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  authBasePath,
  requestReset,
  resetPassword,
  sendCode,
  signIn,
  signOut,
  verifyCode,
} from "./auth.ts";

// The browser side of sign-in: plain fetches to Better Auth's two
// allowed endpoints, with the failure reduced to a code the page can word.

const calls: { url: string; init: RequestInit | undefined }[] = [];
let answer: () => Promise<Response> = () => Promise.resolve(new Response());

const fakeFetch = Object.assign(
  (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ init, url: String(input) });
    return answer();
  },
  { preconnect: () => undefined }
);
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);

afterEach(() => {
  calls.length = 0;
});
afterAll(() => {
  fetchSpy.mockRestore();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

describe("signing in from the browser", () => {
  test("posts the credentials as JSON to Better Auth's sign-in endpoint with the cookies of this origin", async () => {
    answer = () => Promise.resolve(json(200, { user: {} }));
    await signIn({ email: "operator@example.com", password: "12345678" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${authBasePath}/sign-in/email`);
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.credentials).toBe("same-origin");
    expect(new Headers(call?.init?.headers).get("content-type")).toBe(
      "application/json"
    );
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      email: "operator@example.com",
      password: "12345678",
    });
  });

  test("a 200 is a sign-in", async () => {
    answer = () => Promise.resolve(json(200, { user: {} }));
    expect(
      await signIn({ email: "operator@example.com", password: "12345678" })
    ).toEqual({ app: false, ok: true, secondStep: false });
  });

  test.each(["INVALID_EMAIL_OR_PASSWORD", "USER_NOT_FOUND"])(
    "a 401 with the code %s is the one credentials failure, so nothing is learned about the address",
    async (code) => {
      answer = () => Promise.resolve(json(401, { code, message: "x" }));
      expect(
        await signIn({ email: "operator@example.com", password: "12345678" })
      ).toEqual({ failure: "invalid_credentials", ok: false });
    }
  );

  test("a 400 is the same credentials failure: the server was reached and refused the input", async () => {
    answer = () =>
      Promise.resolve(json(400, { code: "INVALID_EMAIL", message: "x" }));
    expect(
      await signIn({ email: "operator@example.com", password: "12345678" })
    ).toEqual({ failure: "invalid_credentials", ok: false });
  });

  test("a 403 is the origin check: the page was not opened at the public address, which says nothing about the credentials", async () => {
    answer = () =>
      Promise.resolve(new Response("Invalid origin", { status: 403 }));
    expect(
      await signIn({ email: "operator@example.com", password: "12345678" })
    ).toEqual({ failure: "origin_refused", ok: false });
  });

  test("a 429 is the rate limit", async () => {
    answer = () =>
      Promise.resolve(
        new Response("Too many requests", {
          headers: { "retry-after": "10" },
          status: 429,
        })
      );
    expect(
      await signIn({ email: "operator@example.com", password: "12345678" })
    ).toEqual({ failure: "rate_limited", ok: false });
  });

  test("a 503 or a network failure is unavailable", async () => {
    answer = () => Promise.resolve(new Response(null, { status: 503 }));
    expect(
      await signIn({ email: "operator@example.com", password: "12345678" })
    ).toEqual({ failure: "unavailable", ok: false });
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(
      await signIn({ email: "operator@example.com", password: "12345678" })
    ).toEqual({ failure: "unavailable", ok: false });
  });
});

describe("signing out from the browser", () => {
  test("posts to Better Auth's sign-out endpoint and answers whether the server confirmed", async () => {
    answer = () => Promise.resolve(json(200, { success: true }));
    expect(await signOut()).toBe(true);
    expect(calls[0]?.url).toBe(`${authBasePath}/sign-out`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await signOut()).toBe(false);
  });
});

describe("the second step from the browser", () => {
  test("a sign-in Better Auth answers with twoFactorRedirect is ok with the second step due", async () => {
    answer = () =>
      Promise.resolve(
        json(200, { twoFactorMethods: ["otp"], twoFactorRedirect: true })
      );
    expect(
      await signIn({ email: "operator@example.com", password: "12345678" })
    ).toEqual({ app: false, ok: true, secondStep: true });
  });

  test("a sign-in that names the authenticator app among the ways in asks for the app's code", async () => {
    answer = () =>
      Promise.resolve(
        json(200, {
          twoFactorMethods: ["totp", "otp"],
          twoFactorRedirect: true,
        })
      );
    expect(
      await signIn({ email: "operator@example.com", password: "12345678" })
    ).toEqual({ app: true, ok: true, secondStep: true });
  });

  test("asking for a code posts to send-otp; a 401 is a spent sign-in that must start over", async () => {
    answer = () => Promise.resolve(json(200, { status: true }));
    expect(await sendCode()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${authBasePath}/two-factor/send-otp`);
    answer = () =>
      Promise.resolve(json(401, { code: "INVALID_TWO_FACTOR_COOKIE" }));
    expect(await sendCode()).toEqual({ failure: "expired", ok: false });
    answer = () => Promise.resolve(json(429, {}));
    expect(await sendCode()).toEqual({ failure: "rate_limited", ok: false });
  });

  test("a code is posted with the trust choice, Arabic digits made Western, and each refusal is its code", async () => {
    answer = () => Promise.resolve(json(200, { token: "t", user: {} }));
    expect(await verifyCode({ code: "١٢٣٤٥٦", trust: true }, "email")).toEqual({
      ok: true,
    });
    expect(calls[0]?.url).toBe(`${authBasePath}/two-factor/verify-otp`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      code: "123456",
      trustDevice: true,
    });
    await verifyCode({ code: "654321", trust: false }, "email");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      code: "654321",
      trustDevice: false,
    });
    expect(await verifyCode({ code: "12345", trust: false }, "email")).toEqual({
      failure: "wrong_code",
      ok: false,
    });
    answer = () => Promise.resolve(json(401, { code: "INVALID_CODE" }));
    expect(await verifyCode({ code: "000000", trust: false }, "email")).toEqual(
      {
        failure: "wrong_code",
        ok: false,
      }
    );
    answer = () =>
      Promise.resolve(
        json(400, { code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" })
      );
    expect(await verifyCode({ code: "000000", trust: false }, "email")).toEqual(
      {
        failure: "no_attempts_left",
        ok: false,
      }
    );
    answer = () => Promise.resolve(json(400, { code: "OTP_HAS_EXPIRED" }));
    expect(await verifyCode({ code: "000000", trust: false }, "email")).toEqual(
      {
        failure: "expired",
        ok: false,
      }
    );
    answer = () =>
      Promise.resolve(json(401, { code: "INVALID_TWO_FACTOR_COOKIE" }));
    expect(await verifyCode({ code: "000000", trust: false }, "email")).toEqual(
      {
        failure: "expired",
        ok: false,
      }
    );
    answer = () => Promise.reject(new Error("offline"));
    expect(await verifyCode({ code: "000000", trust: false }, "email")).toEqual(
      {
        failure: "unavailable",
        ok: false,
      }
    );
  });

  test("the app's code is posted to verify-totp with the trust choice, Arabic digits made Western", async () => {
    answer = () => Promise.resolve(json(200, { token: "t", user: {} }));
    expect(await verifyCode({ code: "١٢٣٤٥٦", trust: true }, "app")).toEqual({
      ok: true,
    });
    expect(calls[0]?.url).toBe(`${authBasePath}/two-factor/verify-totp`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      code: "123456",
      trustDevice: true,
    });
  });

  test("a backup code is posted to verify-backup-code as it was shown, whatever the case, spaces or dash it was typed with", async () => {
    answer = () => Promise.resolve(json(200, { token: "t", user: {} }));
    for (const typed of [
      "abcde-12345",
      " ABCDE-12345 ",
      "abcde12345",
      "abcde 12345",
      "ABCDE-١٢٣٤٥",
    ]) {
      calls.length = 0;
      // biome-ignore lint/performance/noAwaitInLoops: one typing at a time, so a failure names it
      const result1 = await verifyCode({ code: typed, trust: false }, "backup");
      expect([typed, result1]).toEqual([typed, { ok: true }]);
      expect(calls[0]?.url).toBe(
        `${authBasePath}/two-factor/verify-backup-code`
      );
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        code: "abcde-12345",
        trustDevice: false,
      });
    }
  });

  test("a backup code of the wrong length or with other characters is wrong without a call", async () => {
    for (const typed of ["abcde-1234", "abcde-123456", "abcde_12345", ""]) {
      calls.length = 0;
      // biome-ignore lint/performance/noAwaitInLoops: one typing at a time, so a failure names it
      const result2 = await verifyCode({ code: typed, trust: false }, "backup");
      expect([typed, result2]).toEqual([
        typed,
        { failure: "wrong_code", ok: false },
      ]);
      expect(calls).toEqual([]);
    }
  });

  test("a wrong or used backup code is the wrong-code failure", async () => {
    answer = () => Promise.resolve(json(401, { code: "INVALID_BACKUP_CODE" }));
    expect(
      await verifyCode({ code: "abcde-12345", trust: false }, "backup")
    ).toEqual({ failure: "wrong_code", ok: false });
  });

  test("with the app or a backup code, a spent or expired sign-in starts over from the password: no new code can save it", async () => {
    for (const method of ["app", "backup"] as const) {
      const code = method === "app" ? "000000" : "abcde-12345";
      answer = () =>
        Promise.resolve(
          json(400, { code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" })
        );
      // biome-ignore lint/performance/noAwaitInLoops: one method at a time, so a failure names it
      const result3 = await verifyCode({ code, trust: false }, method);
      expect([method, result3]).toEqual([
        method,
        { failure: "start_over", ok: false },
      ]);
      answer = () =>
        Promise.resolve(json(401, { code: "INVALID_TWO_FACTOR_COOKIE" }));
      const result4 = await verifyCode({ code, trust: false }, method);
      expect([method, result4]).toEqual([
        method,
        { failure: "start_over", ok: false },
      ]);
    }
  });

  test("a locked second step is told apart from the rate limit, by every method", async () => {
    for (const method of ["app", "backup", "email"] as const) {
      const code = method === "backup" ? "abcde-12345" : "000000";
      answer = () =>
        Promise.resolve(json(429, { code: "ACCOUNT_TEMPORARILY_LOCKED" }));
      // biome-ignore lint/performance/noAwaitInLoops: one method at a time, so a failure names it
      const result5 = await verifyCode({ code, trust: false }, method);
      expect([method, result5]).toEqual([
        method,
        { failure: "locked", ok: false },
      ]);
      answer = () => Promise.resolve(json(429, {}));
      const result6 = await verifyCode({ code, trust: false }, method);
      expect([method, result6]).toEqual([
        method,
        { failure: "rate_limited", ok: false },
      ]);
    }
  });
});

describe("password recovery from the browser", () => {
  test("the reset request posts the address; a server error reads as unavailable", async () => {
    answer = () => Promise.resolve(json(200, { status: true }));
    expect(await requestReset({ email: "operator@example.com" })).toEqual({
      ok: true,
    });
    expect(calls[0]?.url).toBe(`${authBasePath}/request-password-reset`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: "operator@example.com",
    });
    answer = () =>
      Promise.resolve(json(500, { code: "INTERNAL_SERVER_ERROR" }));
    expect(await requestReset({ email: "operator@example.com" })).toEqual({
      failure: "unavailable",
      ok: false,
    });
    answer = () => Promise.resolve(json(429, {}));
    expect(await requestReset({ email: "operator@example.com" })).toEqual({
      failure: "rate_limited",
      ok: false,
    });
    expect(await requestReset({ email: "not an address" })).toEqual({
      failure: "unavailable",
      ok: false,
    });
  });

  test("the reset posts the token and the new password; a refused token is an invalid link", async () => {
    answer = () => Promise.resolve(json(200, { status: true }));
    expect(
      await resetPassword({ newPassword: "a brand new password", token: "abc" })
    ).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${authBasePath}/reset-password`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      newPassword: "a brand new password",
      token: "abc",
    });
    answer = () => Promise.resolve(json(400, { code: "INVALID_TOKEN" }));
    expect(
      await resetPassword({ newPassword: "a brand new password", token: "abc" })
    ).toEqual({ failure: "invalid_link", ok: false });
    expect(await resetPassword({ newPassword: "short", token: "abc" })).toEqual(
      { failure: "unavailable", ok: false }
    );
    // A refusal that is not the token leaves the link usable.
    answer = () => Promise.resolve(json(400, { code: "PASSWORD_TOO_SHORT" }));
    expect(
      await resetPassword({ newPassword: "a brand new password", token: "abc" })
    ).toEqual({ failure: "unavailable", ok: false });
  });
});
