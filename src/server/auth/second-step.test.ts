import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createChannel, editChannel } from "@/server/notify/channels.ts";
import { fakeSmtp } from "@/server/notify/fixture.ts";
import { runSql } from "@/server/storage/fixture.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { changeOperatorEmail } from "./account.ts";
import { type Auth, createAuth, mailSettled, operatorName } from "./auth.ts";
import {
  appCode,
  authWithOperator,
  call,
  capturingMail,
  cookiesOf,
  type Scratch,
  scratchStorage,
  setsSession,
  signIn,
  silentMail,
  testEmail,
  testPassword,
  testSecrets,
} from "./fixture.ts";
import { authEmailTested } from "./mail.ts";
import {
  chooseAuthEmailChannel,
  confirmApp,
  newBackupCodes,
  readSecondStep,
  sendAuthTest,
  setUpApp,
  switchSecondStep,
  turnAppOff,
} from "./second-step.ts";

// The second step: an emailed six-digit one-time code after the
// password, five minutes and three attempts, stored hashed; the trusted
// browser for 30 days; the switch on the auth settings screen, which opens
// only after a test message went through; the authenticator app and its
// backup codes. Over the handler, on both backends.

let open: Scratch | undefined;
async function scratch(): Promise<Scratch> {
  open = await scratchStorage();
  return open;
}
afterEach(async () => {
  setSystemTime();
  await open?.cleanup();
  open = undefined;
});

const sixDigits = /^\d{6}$/;
const minute = 60_000;

/** The operator signed in with the second step switched on through Better Auth itself. */
async function withSecondStep(
  storage: Storage,
  mail = capturingMail()
): Promise<{ auth: Auth; sent: typeof mail.sent }> {
  const auth = await authWithOperator(storage, mail.mail);
  const session = cookiesOf(await signIn(auth));
  await auth.api.enableTwoFactor({
    body: { method: "otp", password: testPassword },
    headers: new Headers({ cookie: session }),
  });
  return { auth, sent: mail.sent };
}

/** A sign-in that stops at the second step: its pending cookie and the code that was sent. */
async function pendingSignIn(
  auth: Auth,
  sent: { kind: string; value: string }[]
): Promise<{ cookie: string; code: string }> {
  const cookie = cookiesOf(await signIn(auth));
  await call(auth, "/two-factor/send-otp", { body: {}, cookie });
  const code = sent.findLast((m) => m.kind === "code")?.value ?? "";
  return { code, cookie };
}

describe("signing in with the second step on", () => {
  test("the password alone opens no session: the sign-in answers that the second step is due", async () => {
    const { storage } = await scratch();
    const { auth } = await withSecondStep(storage);
    const response = await signIn(auth);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    expect(setsSession(response)).toBe(false);
  });

  test("the code is six digits, emailed to the operator's address, stored hashed and valid for five minutes", async () => {
    const { location, storage } = await scratch();
    const { auth, sent } = await withSecondStep(storage);
    const before = Date.now();
    const { code } = await pendingSignIn(auth, sent);
    const message = sent.findLast((m) => m.kind === "code");
    expect(message?.to).toBe(testEmail);
    expect(code).toMatch(sixDigits);
    const [row] = await runSql(
      location,
      "SELECT value, expires_at FROM auth_verification WHERE identifier LIKE '2fa-otp-%'"
    );
    expect(String(row?.value)).not.toContain(code);
    const expiresAt = Number(row?.expires_at);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 5 * minute);
    expect(expiresAt).toBeLessThan(before + 6 * minute);
  });

  test("the code request answers before the one-time code's send ends, so a slow mail server does not hold the sign-in", async () => {
    const { storage } = await scratch();
    const held = Promise.withResolvers<void>();
    let sent = false;
    const { auth } = await withSecondStep(storage, {
      mail: {
        code: async () => {
          await held.promise;
          sent = true;
        },
        resetLink: () => Promise.resolve(),
      },
      sent: [],
    });
    const cookie = cookiesOf(await signIn(auth));
    const answering = call(auth, "/two-factor/send-otp", { body: {}, cookie });
    try {
      const answer = await Promise.race([
        answering,
        Bun.sleep(1000).then(() => "still waiting for the send" as const),
      ]);
      expect(typeof answer === "string" ? answer : answer.status).toBe(200);
      expect(sent).toBe(false);
    } finally {
      held.resolve();
      await answering;
      await mailSettled();
    }
  });

  test("the right code opens the session and counts the address as verified", async () => {
    const { location, storage } = await scratch();
    const { auth, sent } = await withSecondStep(storage);
    const { code, cookie } = await pendingSignIn(auth, sent);
    const response = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: false },
      cookie,
    });
    expect(response.status).toBe(200);
    expect(setsSession(response)).toBe(true);
    const [user] = await runSql(
      location,
      "SELECT email_verified FROM auth_user"
    );
    expect(Number(user?.email_verified)).toBe(1);
  });

  test("three wrong codes use the code up: the right one is refused after them", async () => {
    const { storage } = await scratch();
    const { auth, sent } = await withSecondStep(storage);
    const { code, cookie } = await pendingSignIn(auth, sent);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each wrong code counts after the one before it
      const attempt = await call(auth, "/two-factor/verify-otp", {
        body: { code: wrong, trustDevice: false },
        cookie,
      });
      expect(attempt.status).toBe(401);
    }
    const late = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: false },
      cookie,
    });
    expect(late.ok).toBe(false);
    expect(setsSession(late)).toBe(false);
  });

  test("a code older than five minutes is refused", async () => {
    const { storage } = await scratch();
    const { auth, sent } = await withSecondStep(storage);
    const { code, cookie } = await pendingSignIn(auth, sent);
    setSystemTime(new Date(Date.now() + 5 * minute + 1000));
    const response = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: false },
      cookie,
    });
    expect(response.ok).toBe(false);
    expect(setsSession(response)).toBe(false);
  });

  test("a trusted browser skips the second step for 30 days, as a row Raaqeb can delete", async () => {
    const { location, storage } = await scratch();
    const { auth, sent } = await withSecondStep(storage);
    const { code, cookie } = await pendingSignIn(auth, sent);
    const verified = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: true },
      cookie,
    });
    const trust = cookiesOf(verified)
      .split("; ")
      .find((pair) => pair.startsWith("raaqeb.trust_device="));
    expect(trust).toBeDefined();
    const [row] = await runSql(
      location,
      "SELECT expires_at FROM auth_verification WHERE identifier LIKE 'trust-device-%'"
    );
    const day = 24 * 60 * minute;
    expect(Number(row?.expires_at)).toBeGreaterThan(Date.now() + 29 * day);
    expect(Number(row?.expires_at)).toBeLessThan(Date.now() + 31 * day);
    const again = await signIn(auth, { cookie: trust });
    expect(again.status).toBe(200);
    expect(setsSession(again)).toBe(true);
  });

  test("enabling, disabling, the app's URI and new backup codes stay closed over HTTP: the settings page calls them on the server", async () => {
    const { storage } = await scratch();
    const { auth } = await withSecondStep(storage);
    const session = cookiesOf(await signIn(auth));
    for (const path of [
      "/two-factor/enable",
      "/two-factor/disable",
      "/two-factor/generate-backup-codes",
      "/two-factor/get-totp-uri",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one endpoint at a time, so a failure names its path
      const response = await call(auth, path, {
        body: { code: "000000", password: testPassword },
        cookie: session,
      });
      expect([path, response.status]).toEqual([path, 404]);
    }
  });
});

describe("the second step's HTTP endpoints serve only a pending sign-in", () => {
  test("a signed-in session cannot turn the second step on by sending and entering a code itself", async () => {
    const { location, storage } = await scratch();
    const mail = capturingMail();
    const auth = await authWithOperator(storage, mail.mail);
    const session = cookiesOf(await signIn(auth));
    const send = await call(auth, "/two-factor/send-otp", {
      body: {},
      cookie: session,
    });
    expect(send.ok).toBe(false);
    const code =
      mail.sent.findLast((m) => m.kind === "code")?.value ?? "000000";
    const verify = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: false },
      cookie: session,
    });
    expect(verify.ok).toBe(false);
    const [user] = await runSql(
      location,
      "SELECT two_factor_enabled FROM auth_user"
    );
    expect(Number(user?.two_factor_enabled)).toBe(0);
  });

  test("a signed-in session cannot spend an app code or a backup code over HTTP", async () => {
    const { storage } = await scratch();
    const { auth, backupCodes, session, uri } = await withApp(storage);
    const cookie = session.get("cookie") ?? "";
    const app = await call(auth, "/two-factor/verify-totp", {
      body: { code: appCode(uri), trustDevice: false },
      cookie,
    });
    expect(app.status).toBe(403);
    const backup = await call(auth, "/two-factor/verify-backup-code", {
      body: { code: backupCodes[0], trustDevice: false },
      cookie,
    });
    expect(backup.status).toBe(403);
    // The refused call spent nothing: the code still signs in.
    const pending = cookiesOf(await signIn(auth));
    const used = await call(auth, "/two-factor/verify-backup-code", {
      body: { code: backupCodes[0], trustDevice: false },
      cookie: pending,
    });
    expect(setsSession(used)).toBe(true);
  });
});

/** The operator with the authenticator app set up through the settings page's functions: its URI, its ten backup codes and the session the first code re-issued. */
async function withApp(
  storage: Storage,
  mail = capturingMail()
): Promise<{
  auth: Auth;
  backupCodes: readonly string[];
  sent: typeof mail.sent;
  session: Headers;
  uri: string;
}> {
  const auth = await authWithOperator(storage, mail.mail);
  const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
  const setUp = await setUpApp(auth, headers, { password: testPassword });
  if (!setUp.ok) {
    throw new Error(`the app was not set up: ${setUp.reason}`);
  }
  const confirmed = await confirmApp(auth, headers, {
    code: appCode(setUp.uri),
  });
  if (!confirmed.ok) {
    throw new Error(`the first code was refused: ${confirmed.reason}`);
  }
  return {
    auth,
    backupCodes: setUp.backupCodes,
    sent: mail.sent,
    session: new Headers({
      cookie: confirmed.setCookies.map((set) => set.split(";")[0]).join("; "),
    }),
    uri: setUp.uri,
  };
}

const backupCodeShape = /^[a-z0-9]{5}-[a-z0-9]{5}$/;
const base32 = /^[A-Z2-7]+$/;

describe("setting up the authenticator app", () => {
  test("a wrong password sets nothing up", async () => {
    const { location, storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    expect(
      await setUpApp(auth, headers, { password: "not the password" })
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect(await runSql(location, "SELECT id FROM auth_two_factor")).toEqual(
      []
    );
  });

  test("the password answers the secret as text and in the QR code's URI, named for the install's host and the operator's address, with ten distinct backup codes", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    const setUp = await setUpApp(auth, headers, { password: testPassword });
    if (!setUp.ok) {
      throw new Error(setUp.reason);
    }
    expect(setUp.secret).toMatch(base32);
    const uri = new URL(setUp.uri);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(setUp.secret);
    expect(uri.searchParams.get("issuer")).toBe("Raaqeb (raaqeb.test)");
    expect(decodeURIComponent(uri.pathname)).toContain(testEmail);
    expect(setUp.backupCodes).toHaveLength(10);
    expect(new Set(setUp.backupCodes).size).toBe(10);
    for (const code of setUp.backupCodes) {
      expect(code).toMatch(backupCodeShape);
    }
  });

  test("an address with a port names the install by its host name alone: a colon would end the issuer in the app's label", async () => {
    const { storage } = await scratch();
    const auth = createAuth({
      baseURL: "http://raaqeb.test:8080",
      database: storage.authDatabase,
      log: () => undefined,
      mail: silentMail,
      secrets: testSecrets,
    });
    await auth.api.signUpEmail({
      body: { email: testEmail, name: operatorName, password: testPassword },
    });
    const { headers } = await auth.api.signInEmail({
      body: { email: testEmail, password: testPassword },
      returnHeaders: true,
    });
    const session = new Headers({
      cookie: headers
        .getSetCookie()
        .map((set) => set.split(";")[0])
        .join("; "),
    });
    const setUp = await setUpApp(auth, session, { password: testPassword });
    if (!setUp.ok) {
      throw new Error(setUp.reason);
    }
    const uri = new URL(setUp.uri);
    expect(uri.searchParams.get("issuer")).toBe("Raaqeb (raaqeb.test)");
    expect(decodeURIComponent(uri.pathname).split(":")).toEqual([
      "/Raaqeb (raaqeb.test)",
      testEmail,
    ]);
  });

  test("an IPv6 address names the install as Raaqeb alone: its colons would end the issuer too", async () => {
    const { storage } = await scratch();
    const auth = createAuth({
      baseURL: "http://[2001:db8::1]",
      database: storage.authDatabase,
      log: () => undefined,
      mail: silentMail,
      secrets: testSecrets,
    });
    await auth.api.signUpEmail({
      body: { email: testEmail, name: operatorName, password: testPassword },
    });
    const { headers } = await auth.api.signInEmail({
      body: { email: testEmail, password: testPassword },
      returnHeaders: true,
    });
    const session = new Headers({
      cookie: headers
        .getSetCookie()
        .map((set) => set.split(";")[0])
        .join("; "),
    });
    const setUp = await setUpApp(auth, session, { password: testPassword });
    if (!setUp.ok) {
      throw new Error(setUp.reason);
    }
    expect(new URL(setUp.uri).searchParams.get("issuer")).toBe("Raaqeb");
  });

  test("the secret and the backup codes are stored encrypted", async () => {
    const { location, storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    const setUp = await setUpApp(auth, headers, { password: testPassword });
    if (!setUp.ok) {
      throw new Error(setUp.reason);
    }
    const [row] = await runSql(
      location,
      "SELECT secret, backup_codes FROM auth_two_factor"
    );
    const stored = `${String(row?.secret)} ${String(row?.backup_codes)}`;
    expect(stored).not.toContain(setUp.secret);
    for (const code of setUp.backupCodes) {
      expect(stored).not.toContain(code);
    }
  });

  test("until its first code the app is not in force: the second step stays off and the password alone signs in", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    await setUpApp(auth, headers, { password: testPassword });
    expect(await readSecondStep(storage)).toMatchObject({
      app: false,
      on: false,
    });
    expect(setsSession(await signIn(auth))).toBe(true);
  });

  test("a wrong first code is refused and changes nothing", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    const setUp = await setUpApp(auth, headers, { password: testPassword });
    if (!setUp.ok) {
      throw new Error(setUp.reason);
    }
    const right = appCode(setUp.uri);
    const wrong = right === "000000" ? "111111" : "000000";
    expect(await confirmApp(auth, headers, { code: wrong })).toEqual({
      ok: false,
      reason: "wrong_code",
    });
    expect(await readSecondStep(storage)).toMatchObject({
      app: false,
      on: false,
    });
  });

  test("a first code that is not six digits is refused before Better Auth", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    await setUpApp(auth, headers, { password: testPassword });
    expect(await confirmApp(auth, headers, { code: "12345" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("the first code, Arabic digits accepted, puts the app in force and turns the second step on", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    const setUp = await setUpApp(auth, headers, { password: testPassword });
    if (!setUp.ok) {
      throw new Error(setUp.reason);
    }
    const arabic = [...appCode(setUp.uri)]
      .map((digit) => String.fromCodePoint(0x6_60 + Number(digit)))
      .join("");
    const confirmed = await confirmApp(auth, headers, { code: arabic });
    expect(confirmed.ok).toBe(true);
    // The session is re-issued with the step on; the page adopts its cookie.
    expect(confirmed.ok && confirmed.setCookies.length).toBeGreaterThan(0);
    expect(await readSecondStep(storage)).toMatchObject({
      app: true,
      on: true,
    });
  });

  test("a setup left before its first code starts again with a new secret; the old secret's codes put nothing in force", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    const first = await setUpApp(auth, headers, { password: testPassword });
    const second = await setUpApp(auth, headers, { password: testPassword });
    if (!(first.ok && second.ok)) {
      throw new Error("the app was not set up");
    }
    expect(second.secret).not.toBe(first.secret);
    const stale = appCode(first.uri);
    if (stale !== appCode(second.uri)) {
      expect(await confirmApp(auth, headers, { code: stale })).toEqual({
        ok: false,
        reason: "wrong_code",
      });
    }
    expect(
      (await confirmApp(auth, headers, { code: appCode(second.uri) })).ok
    ).toBe(true);
  });

  test("a first code with no setup started is refused as unavailable", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    expect(await confirmApp(auth, headers, { code: "123456" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  test("a password longer than any password can be is the wrong password, not an outage", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    expect(
      await setUpApp(auth, headers, { password: "x".repeat(200) })
    ).toEqual({ ok: false, reason: "wrong_password" });
  });

  test("setting it up again while it is in force is refused", async () => {
    const { storage } = await scratch();
    const { auth, session } = await withApp(storage);
    const again = await setUpApp(auth, session, { password: testPassword });
    expect(again.ok).toBe(false);
  });

  test("with the email second step already on, the app joins it", async () => {
    const { storage } = await scratch();
    const { auth, sent } = await withSecondStep(storage);
    const { code, cookie } = await pendingSignIn(auth, sent);
    const verified = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: false },
      cookie,
    });
    const headers = new Headers({ cookie: cookiesOf(verified) });
    const setUp = await setUpApp(auth, headers, { password: testPassword });
    if (!setUp.ok) {
      throw new Error(setUp.reason);
    }
    expect(
      (await confirmApp(auth, headers, { code: appCode(setUp.uri) })).ok
    ).toBe(true);
    expect(await readSecondStep(storage)).toMatchObject({
      app: true,
      on: true,
    });
  });
});

describe("signing in with the authenticator app", () => {
  test("the password alone opens no session, and the sign-in names the app among the ways in", async () => {
    const { storage } = await scratch();
    const { auth } = await withApp(storage);
    const response = await signIn(auth);
    expect(setsSession(response)).toBe(false);
    const body = await response.json();
    expect(body).toMatchObject({ twoFactorRedirect: true });
    expect(body.twoFactorMethods).toContain("totp");
  });

  test("the app's code opens the session, and a wrong one is refused", async () => {
    const { storage } = await scratch();
    const { auth, uri } = await withApp(storage);
    const cookie = cookiesOf(await signIn(auth));
    const right = appCode(uri);
    const wrong = right === "000000" ? "111111" : "000000";
    const refused = await call(auth, "/two-factor/verify-totp", {
      body: { code: wrong, trustDevice: false },
      cookie,
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: "INVALID_CODE" });
    const verified = await call(auth, "/two-factor/verify-totp", {
      body: { code: right, trustDevice: false },
      cookie,
    });
    expect(verified.status).toBe(200);
    expect(setsSession(verified)).toBe(true);
  });

  test("the code of the 30 seconds before or after is accepted, for a phone's clock that drifts; two steps away is not", async () => {
    const { storage } = await scratch();
    const { auth, uri } = await withApp(storage);
    const step = 30_000;
    // A step boundary passes during each sign-in, the slowest run there is; a
    // code built before the sign-in would then be two steps back, not one.
    const first = (Math.floor(Date.now() / step) + 2) * step;
    const signInAcrossBoundary = async (boundary: number): Promise<string> => {
      setSystemTime(new Date(boundary - 1));
      const cookie = cookiesOf(await signIn(auth));
      setSystemTime(new Date(boundary));
      return cookie;
    };
    const cookie = await signInAcrossBoundary(first);
    const near = await call(auth, "/two-factor/verify-totp", {
      body: { code: appCode(uri, Date.now() - step), trustDevice: false },
      cookie,
    });
    expect(setsSession(near)).toBe(true);
    const farCookie = await signInAcrossBoundary(first + step);
    const far = appCode(uri, Date.now() + 2 * step);
    const nearby = [-1, 0, 1].map((n) => appCode(uri, Date.now() + n * step));
    if (!nearby.includes(far)) {
      const refused = await call(auth, "/two-factor/verify-totp", {
        body: { code: far, trustDevice: false },
        cookie: farCookie,
      });
      expect(refused.status).toBe(401);
    }
  });

  test("an app code that signed in once is refused the second time, though its 30 seconds have not passed", async () => {
    const { storage } = await scratch();
    const { auth, uri } = await withApp(storage);
    const code = appCode(uri);
    const first = await call(auth, "/two-factor/verify-totp", {
      body: { code, trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(first)).toBe(true);
    const again = await call(auth, "/two-factor/verify-totp", {
      body: { code, trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(again)).toBe(false);
    expect(await again.json()).toMatchObject({ code: "INVALID_CODE" });
  });

  test("five wrong codes end the pending sign-in: the right one is refused after them", async () => {
    const { storage } = await scratch();
    const { auth, uri } = await withApp(storage);
    const cookie = cookiesOf(await signIn(auth));
    const right = appCode(uri);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each wrong code counts after the one before it
      await call(auth, "/two-factor/verify-totp", {
        body: { code: wrong, trustDevice: false },
        cookie,
      });
    }
    const late = await call(auth, "/two-factor/verify-totp", {
      body: { code: right, trustDevice: false },
      cookie,
    });
    expect(setsSession(late)).toBe(false);
    expect(await late.json()).toMatchObject({
      code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
    });
  });

  test("ten wrong codes in a row lock the second step for 15 minutes, across sign-ins", async () => {
    const { storage } = await scratch();
    const { auth, uri } = await withApp(storage);
    const right = appCode(uri);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let round = 0; round < 2; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each sign-in follows the one before it
      const cookie = cookiesOf(await signIn(auth));
      for (let i = 0; i < 5; i += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each wrong code counts after the one before it
        await call(auth, "/two-factor/verify-totp", {
          body: { code: wrong, trustDevice: false },
          cookie,
        });
      }
    }
    const locked = await call(auth, "/two-factor/verify-totp", {
      body: { code: appCode(uri), trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({
      code: "ACCOUNT_TEMPORARILY_LOCKED",
    });
    setSystemTime(new Date(Date.now() + 15 * minute + 1000));
    const later = await call(auth, "/two-factor/verify-totp", {
      body: { code: appCode(uri), trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(later)).toBe(true);
  });

  test("a trusted browser skips the app's code too", async () => {
    const { storage } = await scratch();
    const { auth, uri } = await withApp(storage);
    const verified = await call(auth, "/two-factor/verify-totp", {
      body: { code: appCode(uri), trustDevice: true },
      cookie: cookiesOf(await signIn(auth)),
    });
    const trust = cookiesOf(verified)
      .split("; ")
      .find((pair) => pair.startsWith("raaqeb.trust_device="));
    expect(trust).toBeDefined();
    expect(setsSession(await signIn(auth, { cookie: trust }))).toBe(true);
  });

  test("with the app set up, an emailed code still signs in", async () => {
    const { storage } = await scratch();
    const { auth, sent } = await withApp(storage);
    const { code, cookie } = await pendingSignIn(auth, sent);
    expect(sent.findLast((m) => m.kind === "code")?.to).toBe(testEmail);
    const verified = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: false },
      cookie,
    });
    expect(setsSession(verified)).toBe(true);
  });
});

describe("backup codes", () => {
  test("a backup code signs in once; the second time it is refused", async () => {
    const { storage } = await scratch();
    const { auth, backupCodes } = await withApp(storage);
    const [code] = backupCodes;
    const first = await call(auth, "/two-factor/verify-backup-code", {
      body: { code, trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(first)).toBe(true);
    const second = await call(auth, "/two-factor/verify-backup-code", {
      body: { code, trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(second)).toBe(false);
    expect(await second.json()).toMatchObject({ code: "INVALID_BACKUP_CODE" });
    // The others still work.
    const other = await call(auth, "/two-factor/verify-backup-code", {
      body: { code: backupCodes[1], trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(other)).toBe(true);
  });

  test("a new set needs the password, answers ten new codes, and the old set stops working", async () => {
    const { storage } = await scratch();
    const { auth, backupCodes, session } = await withApp(storage);
    expect(
      await newBackupCodes(auth, session, { password: "not the password" })
    ).toEqual({ ok: false, reason: "wrong_password" });
    const renewed = await newBackupCodes(auth, session, {
      password: testPassword,
    });
    if (!renewed.ok) {
      throw new Error(renewed.reason);
    }
    expect(renewed.backupCodes).toHaveLength(10);
    for (const code of renewed.backupCodes) {
      expect(code).toMatch(backupCodeShape);
      expect(backupCodes).not.toContain(code);
    }
    const old = await call(auth, "/two-factor/verify-backup-code", {
      body: { code: backupCodes[0], trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(old)).toBe(false);
    const fresh = await call(auth, "/two-factor/verify-backup-code", {
      body: { code: renewed.backupCodes[0], trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(fresh)).toBe(true);
  });

  test("the backup codes of a setup left before its first code sign nobody in, with emailed codes on", async () => {
    const { storage } = await scratch();
    const { auth, sent } = await withSecondStep(storage);
    const { code, cookie } = await pendingSignIn(auth, sent);
    const verified = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: false },
      cookie,
    });
    const headers = new Headers({ cookie: cookiesOf(verified) });
    const setUp = await setUpApp(auth, headers, { password: testPassword });
    if (!setUp.ok) {
      throw new Error(setUp.reason);
    }
    const backup = await call(auth, "/two-factor/verify-backup-code", {
      body: { code: setUp.backupCodes[0], trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(backup)).toBe(false);
    expect(
      (await newBackupCodes(auth, headers, { password: testPassword })).ok
    ).toBe(false);
  });

  test("without the app there is no set to renew", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    expect(
      (await newBackupCodes(auth, headers, { password: testPassword })).ok
    ).toBe(false);
  });
});

describe("turning the second step off with the app set up", () => {
  test("needs the password, and removes the app and its backup codes", async () => {
    const { location, storage } = await scratch();
    const { auth, backupCodes, session, uri } = await withApp(storage);
    expect(
      await switchSecondStep(auth, session, storage, {
        on: false,
        password: "not the password",
      })
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect(
      (
        await switchSecondStep(auth, session, storage, {
          on: false,
          password: testPassword,
        })
      ).ok
    ).toBe(true);
    expect(await readSecondStep(storage)).toMatchObject({
      app: false,
      on: false,
    });
    expect(await runSql(location, "SELECT id FROM auth_two_factor")).toEqual(
      []
    );
    const signedIn = await signIn(auth);
    expect(setsSession(signedIn)).toBe(true);
    // Nothing of the old app is left to sign in with.
    expect(
      (
        await call(auth, "/two-factor/verify-totp", {
          body: { code: appCode(uri), trustDevice: false },
          cookie: cookiesOf(await signIn(auth)),
        })
      ).ok
    ).toBe(false);
    expect(
      setsSession(
        await call(auth, "/two-factor/verify-backup-code", {
          body: { code: backupCodes[0], trustDevice: false },
          cookie: cookiesOf(await signIn(auth)),
        })
      )
    ).toBe(false);
  });
});

describe("the auth settings screen", () => {
  async function emailChannel(
    scratchOpen: Scratch,
    name: string,
    port: number
  ): Promise<string> {
    const created = await createChannel(
      scratchOpen.storage,
      scratchOpen.boot.installKey,
      {
        appliesToNew: false,
        name,
        type: "email",
        values: {
          from: "raaqeb@example.com",
          host: "127.0.0.1",
          port: String(port),
          security: "none",
          to: "team@example.com",
        },
      }
    );
    if (!created.ok) {
      throw new Error("the email channel was not created");
    }
    return created.channel.id;
  }
  const io = { fetch, now: Date.now };

  test("reads nothing before the operator account exists", async () => {
    const { storage } = await scratch();
    expect(await readSecondStep(storage)).toBeUndefined();
  });

  test("lists every email channel oldest first, the oldest in force, the operator's address, and no test yet", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    await createChannel(s.storage, s.boot.installKey, {
      appliesToNew: false,
      name: "Ops webhook",
      type: "webhook",
      values: { url: "https://example.com/hook" },
    });
    const first = await emailChannel(s, "First", 2525);
    const second = await emailChannel(s, "Second", 2526);
    expect(await readSecondStep(s.storage)).toEqual({
      app: false,
      channel: first,
      channels: [
        { id: first, name: "First" },
        { id: second, name: "Second" },
      ],
      email: testEmail,
      on: false,
      tested: false,
    });
  });

  test("a chosen channel takes over from the oldest; a channel that is not email is refused", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const first = await emailChannel(s, "First", 2525);
    const second = await emailChannel(s, "Second", 2526);
    expect(await chooseAuthEmailChannel(s.storage, second)).toEqual({
      ok: true,
    });
    expect((await readSecondStep(s.storage))?.channel).toBe(second);
    const hook = await createChannel(s.storage, s.boot.installKey, {
      appliesToNew: false,
      name: "Ops webhook",
      type: "webhook",
      values: { url: "https://example.com/hook" },
    });
    expect(
      await chooseAuthEmailChannel(s.storage, hook.ok ? hook.channel.id : "")
    ).toEqual({ ok: false, reason: "invalid" });
    expect((await readSecondStep(s.storage))?.channel).toBe(second);
    expect(first).not.toBe(second);
  });

  test("the test message goes to the operator's address through the channel in force and is remembered for it", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const smtp = fakeSmtp();
    try {
      const id = await emailChannel(s, "Mail", smtp.port);
      expect(await sendAuthTest(s.storage, s.boot.installKey, io)).toEqual({
        ok: true,
      });
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.commands.join("\n")).toContain(`RCPT TO:<${testEmail}>`);
      expect(smtp.commands.join("\n")).not.toContain("team@example.com");
      expect((await s.storage.settings.get(authEmailTested))?.channelId).toBe(
        id
      );
      expect((await readSecondStep(s.storage))?.tested).toBe(true);
    } finally {
      smtp.stop();
    }
  });

  test("a refused test is reported with what the channel saw, and is not remembered", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const smtp = fakeSmtp({ refuseRecipient: testEmail });
    try {
      await emailChannel(s, "Mail", smtp.port);
      const result = await sendAuthTest(s.storage, s.boot.installKey, io);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("failed");
        expect(result.failure?.reason).toBe("unexpected_status");
      }
      expect(await s.storage.settings.get(authEmailTested)).toBeUndefined();
      expect((await readSecondStep(s.storage))?.tested).toBe(false);
    } finally {
      smtp.stop();
    }
  });

  test("without an email channel the test answers no channel", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    expect(await sendAuthTest(s.storage, s.boot.installKey, io)).toEqual({
      ok: false,
      reason: "no_channel",
    });
  });

  test("the switch refuses on until a test message went through the channel in force, then on makes the next sign-in ask for the code", async () => {
    const s = await scratch();
    const { mail, sent } = capturingMail();
    const auth = await authWithOperator(s.storage, mail);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      expect(
        await switchSecondStep(auth, headers, s.storage, {
          on: true,
          password: testPassword,
        })
      ).toEqual({ ok: false, reason: "not_tested" });
      await sendAuthTest(s.storage, s.boot.installKey, io);
      const switched = await switchSecondStep(auth, headers, s.storage, {
        on: true,
        password: testPassword,
      });
      expect(switched.ok).toBe(true);
      if (switched.ok) {
        expect(switched.setCookies.length).toBeGreaterThan(0);
      }
      expect((await readSecondStep(s.storage))?.on).toBe(true);
      const next = await signIn(auth);
      expect(await next.json()).toMatchObject({ twoFactorRedirect: true });
      expect(sent).toEqual([]);
    } finally {
      smtp.stop();
    }
  });

  test("a failed test undoes an earlier one: the switch waits for a test that went through", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const smtp = fakeSmtp();
    await emailChannel(s, "Mail", smtp.port);
    await sendAuthTest(s.storage, s.boot.installKey, io);
    expect((await readSecondStep(s.storage))?.tested).toBe(true);
    smtp.stop();
    const failed = await sendAuthTest(s.storage, s.boot.installKey, io);
    expect(failed.ok).toBe(false);
    expect((await readSecondStep(s.storage))?.tested).toBe(false);
  });

  test("editing the channel after the test asks for a new test", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const smtp = fakeSmtp();
    try {
      const id = await emailChannel(s, "Mail", smtp.port);
      await sendAuthTest(s.storage, s.boot.installKey, io);
      expect((await readSecondStep(s.storage))?.tested).toBe(true);
      const edited = await editChannel(s.storage, s.boot.installKey, id, {
        appliesToNew: false,
        name: "Mail",
        type: "email",
        values: {
          from: "raaqeb@example.com",
          host: "127.0.0.2",
          port: String(smtp.port),
          security: "none",
          to: "team@example.com",
        },
      });
      expect(edited.ok).toBe(true);
      expect((await readSecondStep(s.storage))?.tested).toBe(false);
    } finally {
      smtp.stop();
    }
  });

  test("changing the operator's address after the test asks for a new test, since codes go to the new one", async () => {
    const s = await scratch();
    const auth = await authWithOperator(s.storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      await sendAuthTest(s.storage, s.boot.installKey, io);
      expect((await readSecondStep(s.storage))?.tested).toBe(true);
      const changed = await changeOperatorEmail(
        auth,
        headers,
        { currentPassword: testPassword, email: "typo@example.com" },
        () => Promise.resolve()
      );
      expect(changed.ok).toBe(true);
      expect((await readSecondStep(s.storage))?.tested).toBe(false);
      expect(
        await switchSecondStep(auth, headers, s.storage, {
          on: true,
          password: testPassword,
        })
      ).toEqual({ ok: false, reason: "not_tested" });
    } finally {
      smtp.stop();
    }
  });

  test("choosing another channel after the test asks for a new test", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "First", smtp.port);
      const second = await emailChannel(s, "Second", smtp.port);
      await sendAuthTest(s.storage, s.boot.installKey, io);
      expect((await readSecondStep(s.storage))?.tested).toBe(true);
      await chooseAuthEmailChannel(s.storage, second);
      expect((await readSecondStep(s.storage))?.tested).toBe(false);
    } finally {
      smtp.stop();
    }
  });

  test("a channel picked and not yet saved is the one tested, not the one in force", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const inForce = fakeSmtp();
    const picked = fakeSmtp();
    try {
      await emailChannel(s, "First", inForce.port);
      const second = await emailChannel(s, "Second", picked.port);
      expect(
        await sendAuthTest(s.storage, s.boot.installKey, io, second)
      ).toEqual({ ok: true });
      expect(inForce.messages).toHaveLength(0);
      expect(picked.messages).toHaveLength(1);
      // The proof is for the picked channel: the switch opens once it is saved.
      expect((await readSecondStep(s.storage))?.tested).toBe(false);
      await chooseAuthEmailChannel(s.storage, second);
      expect((await readSecondStep(s.storage))?.tested).toBe(true);
    } finally {
      inForce.stop();
      picked.stop();
    }
  });

  test("a picked channel's failed test leaves the proof of the channel in force", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const inForce = fakeSmtp();
    const picked = fakeSmtp({ refuseRecipient: testEmail });
    try {
      await emailChannel(s, "First", inForce.port);
      const second = await emailChannel(s, "Second", picked.port);
      await sendAuthTest(s.storage, s.boot.installKey, io);
      expect((await readSecondStep(s.storage))?.tested).toBe(true);
      const failed = await sendAuthTest(
        s.storage,
        s.boot.installKey,
        io,
        second
      );
      expect(failed.ok).toBe(false);
      expect((await readSecondStep(s.storage))?.tested).toBe(true);
    } finally {
      inForce.stop();
      picked.stop();
    }
  });

  test("a picked id that is no email channel answers no channel and sends nothing", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      expect(
        await sendAuthTest(s.storage, s.boot.installKey, io, "gone")
      ).toEqual({ ok: false, reason: "no_channel" });
      expect(smtp.messages).toHaveLength(0);
    } finally {
      smtp.stop();
    }
  });

  test("a wrong password refuses the switch either way", async () => {
    const s = await scratch();
    const auth = await authWithOperator(s.storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      await sendAuthTest(s.storage, s.boot.installKey, io);
      expect(
        await switchSecondStep(auth, headers, s.storage, {
          on: true,
          password: "not the password",
        })
      ).toEqual({ ok: false, reason: "wrong_password" });
      const switched = await switchSecondStep(auth, headers, s.storage, {
        on: true,
        password: testPassword,
      });
      // Enabling replaces the session; the page adopts the cookies it answers.
      const renewed = new Headers({
        cookie: switched.ok
          ? switched.setCookies.map((set) => set.split(";")[0]).join("; ")
          : "",
      });
      expect(
        await switchSecondStep(auth, renewed, s.storage, {
          on: false,
          password: "not the password",
        })
      ).toEqual({ ok: false, reason: "wrong_password" });
      expect((await readSecondStep(s.storage))?.on).toBe(true);
    } finally {
      smtp.stop();
    }
  });

  test("turning the app off with emailed codes ready removes the app alone: the second step stays on and the next sign-in asks for an emailed code", async () => {
    const s = await scratch();
    const { auth, backupCodes, sent, session } = await withApp(s.storage);
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "Mail", smtp.port);
      await sendAuthTest(s.storage, s.boot.installKey, io);
      expect(
        await turnAppOff(auth, session, s.storage, {
          password: "not the password",
        })
      ).toEqual({ ok: false, reason: "wrong_password" });
      expect((await readSecondStep(s.storage))?.app).toBe(true);
      expect(
        (
          await turnAppOff(auth, session, s.storage, {
            password: testPassword,
          })
        ).ok
      ).toBe(true);
      expect(await readSecondStep(s.storage)).toMatchObject({
        app: false,
        on: true,
      });
      expect(
        await runSql(s.location, "SELECT id FROM auth_two_factor")
      ).toEqual([]);
      const signedIn = await signIn(auth);
      expect(setsSession(signedIn)).toBe(false);
      const body = await signedIn.json();
      expect(body.twoFactorMethods).toEqual(["otp"]);
      // The emailed code signs in; the old backup codes do not.
      const { code, cookie } = await pendingSignIn(auth, sent);
      const backup = await call(auth, "/two-factor/verify-backup-code", {
        body: { code: backupCodes[0], trustDevice: false },
        cookie,
      });
      expect(setsSession(backup)).toBe(false);
      const emailed = await call(auth, "/two-factor/verify-otp", {
        body: { code, trustDevice: false },
        cookie,
      });
      expect(setsSession(emailed)).toBe(true);
    } finally {
      smtp.stop();
    }
  });

  test("turning the app off with no emailed codes ready turns the second step off with it, since nothing would be left to sign in with", async () => {
    const s = await scratch();
    const { auth, backupCodes, session } = await withApp(s.storage);
    expect(
      await turnAppOff(auth, session, s.storage, {
        password: "not the password",
      })
    ).toEqual({ ok: false, reason: "wrong_password" });
    const off = await turnAppOff(auth, session, s.storage, {
      password: testPassword,
    });
    expect(off.ok).toBe(true);
    // Better Auth re-issues the session with the step off; the page adopts its cookie.
    expect(off.ok && off.setCookies.length).toBeGreaterThan(0);
    expect(await readSecondStep(s.storage)).toMatchObject({
      app: false,
      on: false,
    });
    expect(setsSession(await signIn(auth))).toBe(true);
    const pending = await call(auth, "/two-factor/verify-backup-code", {
      body: { code: backupCodes[0], trustDevice: false },
      cookie: cookiesOf(await signIn(auth)),
    });
    expect(setsSession(pending)).toBe(false);
  });

  test("an emailed-codes test that went through another channel than the one in force does not keep the second step on", async () => {
    const s = await scratch();
    const { auth, session } = await withApp(s.storage);
    const smtp = fakeSmtp();
    try {
      await emailChannel(s, "First", smtp.port);
      await sendAuthTest(s.storage, s.boot.installKey, io);
      const second = await emailChannel(s, "Second", smtp.port);
      await chooseAuthEmailChannel(s.storage, second);
      await turnAppOff(auth, session, s.storage, { password: testPassword });
      expect((await readSecondStep(s.storage))?.on).toBe(false);
    } finally {
      smtp.stop();
    }
  });

  test("off needs no test and ends the second step", async () => {
    const s = await scratch();
    const { auth, sent } = await withSecondStep(s.storage);
    // A full session while the step is on: through the code.
    const { code, cookie } = await pendingSignIn(auth, sent);
    const verified = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: false },
      cookie,
    });
    const headers = new Headers({ cookie: cookiesOf(verified) });
    expect(await s.storage.settings.get(authEmailTested)).toBeUndefined();
    const result = await switchSecondStep(auth, headers, s.storage, {
      on: false,
      password: testPassword,
    });
    expect(result.ok).toBe(true);
    expect((await readSecondStep(s.storage))?.on).toBe(false);
    expect(setsSession(await signIn(auth))).toBe(true);
  });
});
