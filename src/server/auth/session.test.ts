import { afterAll, describe, expect, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage } from "@/server/storage/storage.ts";
import {
  type AuthBoot,
  type AuthMail,
  authFor,
  createAuth,
  operatorName,
} from "./auth.ts";
import {
  isOperator,
  operatorFor,
  operatorOfRequest,
  readOperator,
} from "./session.ts";

const boot: AuthBoot = {
  betterAuthSecrets: undefined,
  installKey: await scratchInstallKey(),
};
/** A mail that sends nothing; the tests of the recovery paths hand their own. */
const silentMail: AuthMail = {
  code: () => Promise.resolve(),
  resetLink: () => Promise.resolve(),
};

const scratch = await scratchDatabase();
const opened = await openStorage(scratch.location);
if (!opened.ok) {
  throw new Error(opened.message);
}
const auth = createAuth({
  baseURL: "http://raaqeb.test",
  database: opened.storage.authDatabase,
  log: () => undefined,
  mail: silentMail,
  secrets: "1:test-secret-test-secret-test-secret-test",
});
const email = "operator@example.com";
const password = "correct horse battery";

afterAll(async () => {
  await opened.storage.close();
  await scratch.cleanup();
});

describe("the signed-in operator behind a request", () => {
  test("is read from the session cookie as an id and an email, nothing more", async () => {
    await auth.api.signUpEmail({
      body: { email, name: operatorName, password },
    });
    const signedIn = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    const session = await readOperator(auth, new Headers({ cookie }));
    expect(session?.operator).toEqual({
      email,
      id: signedIn.response.user.id,
    });
    // A fresh session is not due for refresh: no cookie to re-issue.
    expect(session?.setCookie).toBeUndefined();
  });

  test("carries the re-issued cookie when Better Auth refreshed the session, so the browser's cookie lives on with the row", async () => {
    const signedIn = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    const [, signedValue] = cookie.split("=");
    const [token] = decodeURIComponent(signedValue ?? "").split(".");
    // Five days left: a day of use has passed, so the session is due.
    await runSql(
      scratch.location,
      "UPDATE auth_session SET expires_at = ? WHERE token = ?",
      [Date.now() + 5 * 24 * 60 * 60 * 1000, token ?? ""]
    );
    const session = await readOperator(auth, new Headers({ cookie }));
    expect(session?.operator.email).toBe(email);
    expect(session?.setCookie).toContain("raaqeb.session_token=");
    expect(session?.setCookie).toContain("Max-Age=604800");
  });

  test("is nothing without a cookie", async () => {
    expect(await readOperator(auth, new Headers())).toBeUndefined();
  });

  test("is nothing, never a thrown error, when the session cannot be read (the guard's server function must not throw)", async () => {
    const scratch2 = await scratchDatabase();
    const opened2 = await openStorage(scratch2.location);
    if (!opened2.ok) {
      throw new Error(opened2.message);
    }
    const auth2 = createAuth({
      baseURL: "http://raaqeb.test",
      database: opened2.storage.authDatabase,
      log: () => undefined,
      mail: silentMail,
      secrets: "1:test-secret-test-secret-test-secret-test",
    });
    await auth2.api.signUpEmail({
      body: { email, name: operatorName, password },
    });
    const signedIn = await auth2.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    await opened2.storage.close();
    await scratch2.cleanup();
    expect(await readOperator(auth2, new Headers({ cookie }))).toBeUndefined();
  });

  test("is nothing for a cookie naming a session that does not exist", async () => {
    const forged = "raaqeb.session_token=nope.nope";
    expect(
      await readOperator(auth, new Headers({ cookie: forged }))
    ).toBeUndefined();
  });
});

describe("the operator for a request context", () => {
  test("is read through the storage's instance", async () => {
    const signedIn = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    // The storage's own instance has a secret of its own; a cookie signed by another instance is no session there.
    expect(
      await operatorFor(opened.storage, boot, new Headers({ cookie }))
    ).toBeUndefined();
  });

  test("hands the guard the open storage and the instance it read the session through, so the handlers behind it build nothing again", async () => {
    const own = await authFor(opened.storage, boot);
    const signedIn = await own.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    const context = await operatorFor(
      opened.storage,
      boot,
      new Headers({ cookie })
    );
    expect(context?.operator).toEqual({
      email,
      id: signedIn.response.user.id,
    });
    expect(context?.storage).toBe(opened.storage);
    expect(context?.auth).toBe(own);
  });

  test("is read once a request, so a render's server functions share it, and again for the next request, which sees a sign-out", async () => {
    const own = await authFor(opened.storage, boot);
    const signedIn = await own.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    const request = () =>
      new Request("http://raaqeb.test/admin", { headers: { cookie } });
    const render = request();
    const first = operatorOfRequest(opened.storage, boot, render);
    expect(operatorOfRequest(opened.storage, boot, render)).toBe(first);
    expect((await first)?.operator.email).toBe(email);
    await own.api.signOut({ headers: new Headers({ cookie }) });
    expect(
      await operatorOfRequest(opened.storage, boot, request())
    ).toBeUndefined();
  });

  test("a preview's read sees the session and leaves its expiry where it was, though the session is due for refresh", async () => {
    const own = await authFor(opened.storage, boot);
    const signedIn = await own.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    const [, signedValue] = cookie.split("=");
    const [token] = decodeURIComponent(signedValue ?? "").split(".");
    // Five days left: a day of use has passed, so a refreshing read would extend it.
    const expiresAt = Date.now() + 5 * 24 * 60 * 60 * 1000;
    await runSql(
      scratch.location,
      "UPDATE auth_session SET expires_at = ? WHERE token = ?",
      [expiresAt, token ?? ""]
    );
    expect(
      await isOperator(opened.storage, boot, new Headers({ cookie }))
    ).toBe(true);
    const [row] = await runSql(
      scratch.location,
      "SELECT expires_at FROM auth_session WHERE token = ?",
      [token ?? ""]
    );
    expect(Number(row?.expires_at)).toBe(expiresAt);
    expect(await isOperator(opened.storage, boot, new Headers())).toBe(false);
    expect(await isOperator(undefined, boot, new Headers({ cookie }))).toBe(
      false
    );
  });

  test("is nothing with no database, and nothing when the database cannot answer, never a thrown error", async () => {
    expect(await operatorFor(undefined, boot, new Headers())).toBeUndefined();
    const scratch3 = await scratchDatabase();
    const opened3 = await openStorage(scratch3.location);
    if (!opened3.ok) {
      throw new Error(opened3.message);
    }
    await opened3.storage.close();
    await scratch3.cleanup();
    expect(
      await operatorFor(opened3.storage, boot, new Headers())
    ).toBeUndefined();
  });
});
