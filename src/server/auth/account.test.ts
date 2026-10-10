import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { changeOperatorEmail, changeOperatorPassword } from "./account.ts";
import { type Auth, type AuthMail, createAuth, operatorName } from "./auth.ts";
import { readOperator } from "./session.ts";

/** A mail that sends nothing; the tests of the recovery paths hand their own. */
const silentMail: AuthMail = {
  code: () => Promise.resolve(),
  resetLink: () => Promise.resolve(),
};

const origin = "https://status.example.test";
const email = "operator@example.com";
const password = "correct horse battery";
const secrets = "1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

let open: { storage: Storage; cleanup: () => Promise<void> } | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = { cleanup: scratch.cleanup, storage: opened.storage };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

/** An auth over a fresh database with the operator account created. */
async function authWithOperator(): Promise<Auth> {
  const store = await storage();
  const auth = createAuth({
    baseURL: origin,
    database: store.authDatabase,
    log: () => undefined,
    mail: silentMail,
    secrets,
  });
  await auth.api.signUpEmail({
    body: { email, name: operatorName, password },
  });
  return auth;
}

/** A signed-in browser's headers: the session cookie from a fresh sign-in. */
async function signedIn(auth: Auth, current = password): Promise<Headers> {
  const signIn = await auth.api.signInEmail({
    body: { email, password: current },
    returnHeaders: true,
  });
  return new Headers({ cookie: cookieHeader(signIn.headers.getSetCookie()) });
}

/** The Cookie header value a browser would send back from Set-Cookie values. */
function cookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((value) => value.split(";")[0] ?? "").join("; ");
}

describe("changing the operator's email", () => {
  test("stores the new address and answers the cookies for the session that now names it", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    const result = await changeOperatorEmail(auth, headers, "new@example.com");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.setCookies.length).toBeGreaterThan(0);
    const session = await readOperator(
      auth,
      new Headers({ cookie: cookieHeader(result.setCookies) })
    );
    expect(session?.operator.email).toBe("new@example.com");
  });

  test("the address is lower-cased and the current address is refused as the same", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    expect(
      await changeOperatorEmail(auth, headers, "Operator@Example.com")
    ).toEqual({ ok: false, reason: "same_email" });
  });

  test("without a session it is unavailable", async () => {
    const auth = await authWithOperator();
    expect(
      await changeOperatorEmail(auth, new Headers(), "new@example.com")
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("changing the operator's password", () => {
  test("needs the current password: a wrong one is refused and nothing changes", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    expect(
      await changeOperatorPassword(auth, headers, {
        currentPassword: "not the password",
        newPassword: "another long password",
      })
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect((await readOperator(auth, headers))?.operator.email).toBe(email);
  });

  test("with the current password: the new one signs in, every other session ends, and the caller gets a fresh cookie", async () => {
    const auth = await authWithOperator();
    const other = await signedIn(auth);
    const headers = await signedIn(auth);
    const result = await changeOperatorPassword(auth, headers, {
      currentPassword: password,
      newPassword: "another long password",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(await readOperator(auth, other)).toBeUndefined();
    expect(
      (
        await readOperator(
          auth,
          new Headers({ cookie: cookieHeader(result.setCookies) })
        )
      )?.operator.email
    ).toBe(email);
    expect(
      (await signedIn(auth, "another long password")).get("cookie")
    ).toContain("session_token=");
  });

  test("without a session it is unavailable", async () => {
    const auth = await authWithOperator();
    expect(
      await changeOperatorPassword(auth, new Headers(), {
        currentPassword: password,
        newPassword: "another long password",
      })
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the email change after the address was verified", () => {
  test("still changes the address once a code verified the old one, and the new address is not verified", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    const context = await auth.$context;
    const [user] = await context.internalAdapter.listUsers();
    await context.internalAdapter.updateUser(user?.id ?? "", {
      emailVerified: true,
    });
    const changed = await changeOperatorEmail(auth, headers, "new@example.com");
    expect(changed.ok).toBe(true);
    const after =
      await context.internalAdapter.findUserByEmail("new@example.com");
    expect(after?.user.emailVerified).toBe(false);
  });

  test("the same address is still refused as the same, and stays verified", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    const context = await auth.$context;
    const [user] = await context.internalAdapter.listUsers();
    await context.internalAdapter.updateUser(user?.id ?? "", {
      emailVerified: true,
    });
    expect(await changeOperatorEmail(auth, headers, email)).toEqual({
      ok: false,
      reason: "same_email",
    });
    const after = await context.internalAdapter.findUserByEmail(email);
    expect(after?.user.emailVerified).toBe(true);
  });
});
