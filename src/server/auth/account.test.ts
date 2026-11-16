import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import {
  changeOperatorEmail,
  changeOperatorPassword,
  endOwnSessions,
  readOwnSessions,
  renameOperator,
} from "./account.ts";
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

/** The notices an email change sent, as the old and the new address. */
type Notices = [previous: string, next: string][];

/** Changes the email with the current password unless another is given, collecting the notices. */
function change(
  auth: Auth,
  headers: Headers,
  newEmail: string,
  notices: Notices = [],
  currentPassword = password
) {
  return changeOperatorEmail(
    auth,
    headers,
    { currentPassword, email: newEmail },
    (previous, next) => {
      notices.push([previous, next]);
      return Promise.resolve();
    }
  );
}

describe("changing the operator's email", () => {
  test("stores the new address and answers the cookies for the session that now names it", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    const result = await change(auth, headers, "new@example.com");
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

  test("needs the current password: a wrong one is refused, the address stays and no notice goes", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    const notices: Notices = [];
    expect(
      await change(
        auth,
        headers,
        "new@example.com",
        notices,
        "not the password"
      )
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect((await readOperator(auth, headers))?.operator.email).toBe(email);
    expect(notices).toEqual([]);
  });

  test("tells the address the account had which address it has now", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    const notices: Notices = [];
    expect((await change(auth, headers, "New@Example.com", notices)).ok).toBe(
      true
    );
    expect(notices).toEqual([[email, "new@example.com"]]);
  });

  test("the address is lower-cased and the current address is refused as the same, with no notice", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    const notices: Notices = [];
    expect(
      await change(auth, headers, "Operator@Example.com", notices)
    ).toEqual({ ok: false, reason: "same_email" });
    expect(notices).toEqual([]);
  });

  test("without a session it is unavailable", async () => {
    const auth = await authWithOperator();
    expect(await change(auth, new Headers(), "new@example.com")).toEqual({
      ok: false,
      reason: "unavailable",
    });
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
    const changed = await change(auth, headers, "new@example.com");
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
    expect(await change(auth, headers, email)).toEqual({
      ok: false,
      reason: "same_email",
    });
    const after = await context.internalAdapter.findUserByEmail(email);
    expect(after?.user.emailVerified).toBe(true);
  });

  test("to an address another account has changes nothing and tells nobody, and answers as a change does", async () => {
    const auth = await authWithOperator();
    await auth.api.signUpEmail({
      body: { email: "taken@example.com", name: "", password },
    });
    const headers = await signedIn(auth);
    const context = await auth.$context;
    const mine = await context.internalAdapter.findUserByEmail(email);
    await context.internalAdapter.updateUser(mine?.user.id ?? "", {
      emailVerified: true,
    });
    const notices: Notices = [];
    const answered = await change(auth, headers, "taken@example.com", notices);
    expect(answered.ok).toBe(true);
    expect(notices).toEqual([]);
    const after = await context.internalAdapter.findUserByEmail(email);
    expect(after?.user.emailVerified).toBe(true);
  });
});

describe("the operator's own name", () => {
  test("is changed, trimmed, and may be left empty for the email to stand for it", async () => {
    const auth = await authWithOperator();
    const store = open?.storage;
    if (!store) {
      throw new Error("no storage");
    }
    const session = await readOperator(auth, await signedIn(auth));
    const id = session?.operator.id ?? "";
    expect(await renameOperator(store, id, { name: "  Huda  " })).toEqual({
      ok: true,
    });
    expect((await store.operatorAccounts.find(id))?.name).toBe("Huda");
    expect(await renameOperator(store, id, { name: "" })).toEqual({ ok: true });
    expect((await store.operatorAccounts.find(id))?.name).toBe("");
    expect(await renameOperator(store, id, { name: "x".repeat(101) })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await renameOperator(store, "gone", { name: "Huda" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("the operator's own sessions", () => {
  test("are listed newest first with the one asking marked, and each other one can be ended", async () => {
    const auth = await authWithOperator();
    const store = open?.storage;
    if (!store) {
      throw new Error("no storage");
    }
    const first = await signedIn(auth);
    const second = await signedIn(auth);
    const asking = (await readOperator(auth, second))?.operator;
    if (!asking) {
      throw new Error("not signed in");
    }
    const read = await readOwnSessions(store, asking, Date.now());
    if (!read.ok) {
      throw new Error("not read");
    }
    // The sign-up signed in too, so three.
    expect(read.sessions).toHaveLength(3);
    expect(read.sessions.filter((one) => one.current)).toHaveLength(1);
    expect(read.sessions.find((one) => one.current)?.id).toBe(asking.sessionId);
    const other = read.sessions.find((one) => !one.current)?.id ?? "";
    expect(await endOwnSessions(store, asking, { id: other })).toEqual({
      ok: true,
    });
    expect(await readOperator(auth, first)).toBeUndefined();
    expect(await readOperator(auth, second)).toBeDefined();
  });

  test("ending every other one keeps the one asking; it is never ended here, since signing out does that", async () => {
    const auth = await authWithOperator();
    const store = open?.storage;
    if (!store) {
      throw new Error("no storage");
    }
    const first = await signedIn(auth);
    const third = await signedIn(auth);
    const asking = (await readOperator(auth, third))?.operator;
    if (!asking) {
      throw new Error("not signed in");
    }
    expect(
      await endOwnSessions(store, asking, { id: asking.sessionId })
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await endOwnSessions(store, asking, {})).toEqual({ ok: true });
    expect(await readOperator(auth, first)).toBeUndefined();
    expect(await readOperator(auth, third)).toBeDefined();
  });

  test("another account's session is not the operator's to end", async () => {
    const auth = await authWithOperator();
    const store = open?.storage;
    if (!store) {
      throw new Error("no storage");
    }
    await auth.api.signUpEmail({
      body: { email: "other@example.com", name: "", password },
    });
    const theirs = await auth.api.signInEmail({
      body: { email: "other@example.com", password },
      returnHeaders: true,
    });
    const theirHeaders = new Headers({
      cookie: cookieHeader(theirs.headers.getSetCookie()),
    });
    const theirSession = (await readOperator(auth, theirHeaders))?.operator
      .sessionId;
    const asking = (await readOperator(auth, await signedIn(auth)))?.operator;
    if (!(asking && theirSession)) {
      throw new Error("not signed in");
    }
    expect(await endOwnSessions(store, asking, { id: theirSession })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await readOperator(auth, theirHeaders)).toBeDefined();
  });
});

describe("a database that cannot answer", () => {
  test("leaves the name, the session list and ending sessions unavailable, never a thrown error", async () => {
    const store = await storage();
    await store.close();
    const operator = { id: "a", sessionId: "s" };
    expect(await renameOperator(store, "a", { name: "Huda" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await readOwnSessions(store, operator, 0)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await endOwnSessions(store, operator, {})).toEqual({
      ok: false,
      reason: "unavailable",
    });
    // Closed already: only the scratch files are left to remove.
    await open?.cleanup();
    open = undefined;
  });
});

describe("the current password's checks on the server", () => {
  afterEach(() => {
    setSystemTime();
  });

  const tries = (auth: Auth, headers: Headers, currentPassword: string) =>
    changeOperatorPassword(auth, headers, {
      currentPassword,
      newPassword: "another good password",
    });

  test("after five wrong ones refuse the next for a quarter of an hour, the right one too, then take it again", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    // The clock stands still while the five are typed, so the quarter hour ends at a known millisecond.
    const typedAt = Date.now();
    setSystemTime(typedAt);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count in order
      expect(await tries(auth, headers, "a guess")).toEqual({
        ok: false,
        reason: "wrong_password",
      });
    }
    expect(await tries(auth, headers, password)).toEqual({
      ok: false,
      reason: "too_many_attempts",
    });
    expect(
      await change(auth, headers, "new@example.com", [], password)
    ).toEqual({ ok: false, reason: "too_many_attempts" });
    setSystemTime(typedAt + 15 * 60 * 1000 - 1);
    expect(await tries(auth, headers, password)).toEqual({
      ok: false,
      reason: "too_many_attempts",
    });
    setSystemTime(typedAt + 15 * 60 * 1000);
    expect((await tries(auth, headers, password)).ok).toBe(true);
  });

  test("count each account's own wrong passwords, never another's", async () => {
    const auth = await authWithOperator();
    const headers = await signedIn(auth);
    await auth.api.signUpEmail({
      body: { email: "other@example.com", name: "", password },
    });
    const theirs = await auth.api.signInEmail({
      body: { email: "other@example.com", password },
      returnHeaders: true,
    });
    const theirHeaders = new Headers({
      cookie: cookieHeader(theirs.headers.getSetCookie()),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the attempts count in order
      await tries(auth, theirHeaders, "a guess");
    }
    expect((await tries(auth, headers, password)).ok).toBe(true);
  });
});
