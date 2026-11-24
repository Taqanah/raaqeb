import { afterEach, describe, expect, test } from "bun:test";
import { type Auth, createAuth, operatorName } from "./auth.ts";
import {
  call,
  capturingMail,
  nextAddress,
  type Scratch,
  scratchStorage,
  signIn,
  testEmail,
  testOrigin,
  testPassword,
  testSecrets,
} from "./fixture.ts";
import {
  invitationGate,
  invitationTokenHash,
  newInvitationToken,
} from "./invitation.ts";
import {
  createKnownBrowsers,
  type KnownBrowsers,
  knownBrowserCookieName,
} from "./known-browsers.ts";

// Known browsers over Better Auth's own handler: where the cookie is made,
// whom it names, and what a try from a browser that is not known for the
// account typed may spend.

let open: Scratch | undefined;
afterEach(async () => {
  await open?.cleanup();
  open = undefined;
});

/** An install with the operator account, its counts on a clock the test moves. */
async function install(): Promise<{
  auth: Auth;
  browsers: KnownBrowsers;
  scratch: Scratch;
  sent: ReturnType<typeof capturingMail>["sent"];
  tick: (ms?: number) => void;
}> {
  open = await scratchStorage();
  const scratch = open;
  let now = 1_000_000;
  const browsers = createKnownBrowsers(() => now);
  const { mail, sent } = capturingMail();
  const auth = createAuth({
    baseURL: testOrigin,
    database: scratch.storage.authDatabase,
    installKey: scratch.boot.installKey,
    invitations: invitationGate(scratch.storage),
    knownBrowsers: browsers,
    log: () => undefined,
    mail,
    secrets: testSecrets,
  });
  await auth.api.signUpEmail({
    body: { email: testEmail, name: operatorName, password: testPassword },
  });
  return {
    auth,
    browsers,
    scratch,
    sent,
    tick: (ms = 1000) => {
      now += ms;
    },
  };
}

/** The known-browser cookie a response set, as a Cookie header value. */
function knownOf(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((each) => each.startsWith(`${knownBrowserCookieName}=`))
    ?.split(";")[0];
}

const wrong = { email: testEmail, password: "not the password" };

/** The statuses of `count` tries, a second apart, so the install's five checks a second never decide them. */
async function tries(
  count: number,
  tick: (ms?: number) => void,
  send: () => Promise<Response>
): Promise<number[]> {
  const statuses: number[] = [];
  for (let each = 0; each < count; each += 1) {
    tick();
    // biome-ignore lint/performance/noAwaitInLoops: one try after another, as a person types them
    statuses.push((await send()).status);
  }
  return statuses;
}

describe("where a browser becomes known", () => {
  test("a password alone, on an account with the second step, makes no browser known and keeps the last sign-in as it was; the code that finishes the sign-in does both", async () => {
    const { auth, scratch, sent } = await install();
    const session = (await signIn(auth)).headers
      .getSetCookie()
      .map((each) => each.split(";")[0])
      .join("; ");
    await auth.api.enableTwoFactor({
      body: { method: "otp", password: testPassword },
      headers: new Headers({ cookie: session }),
    });
    const before = (
      await scratch.storage.operatorAccounts.findByEmail(testEmail)
    )?.lastSignInAt;
    const pending = await signIn(auth);
    expect(await pending.clone().json()).toMatchObject({
      twoFactorRedirect: true,
    });
    expect(knownOf(pending)).toBeUndefined();
    expect(
      (await scratch.storage.operatorAccounts.findByEmail(testEmail))
        ?.lastSignInAt
    ).toBe(before);
    const cookie = pending.headers
      .getSetCookie()
      .map((each) => each.split(";")[0])
      .join("; ");
    await call(auth, "/two-factor/send-otp", { body: {}, cookie });
    const code = sent.findLast((each) => each.kind === "code")?.value ?? "";
    await Bun.sleep(5);
    const finished = await call(auth, "/two-factor/verify-otp", {
      body: { code },
      cookie,
    });
    expect(finished.status).toBe(200);
    expect(knownOf(finished)).toBeDefined();
    expect(
      (await scratch.storage.operatorAccounts.findByEmail(testEmail))
        ?.lastSignInAt
    ).not.toBe(before);
  });

  test("accepting an invitation signs in and makes that browser known", async () => {
    const { auth, scratch } = await install();
    const owner = await scratch.storage.operatorAccounts.findByEmail(testEmail);
    const token = newInvitationToken();
    await scratch.storage.invitations.put({
      createdAt: Date.now(),
      email: "new@example.com",
      expiresAt: Date.now() + 60_000,
      id: "i1",
      invitedBy: owner?.id ?? null,
      role: "editor",
      tokenHash: invitationTokenHash(token),
    });
    const accepted = await call(auth, "/invitation/accept", {
      address: nextAddress(),
      body: { name: "Nadia", password: testPassword, token },
    });
    expect(accepted.status).toBe(200);
    expect(knownOf(accepted)).toBeDefined();
  });
});

describe("whom a known browser is known for", () => {
  test("a cookie is known for the account it names alone: its tries at another account count against that account's ten, while it still signs its own in", async () => {
    const { auth, tick } = await install();
    await auth.api.signUpEmail({
      body: {
        email: "other@example.com",
        name: "Other",
        password: testPassword,
      },
    });
    const cookie = knownOf(await signIn(auth));
    const atOther = await tries(11, tick, () =>
      signIn(auth, {
        body: { email: "other@example.com", password: "not the password" },
        cookie,
      })
    );
    expect(atOther).toEqual([...new Array(10).fill(401), 429]);
    tick();
    expect((await signIn(auth, { cookie })).status).toBe(200);
  });

  test("a cookie names the account, not its address: when the address is freed and a new account takes it, the old cookie is a stranger's to the new one", async () => {
    const { auth, scratch, tick } = await install();
    const cookie = knownOf(await signIn(auth));
    const { internalAdapter } = await auth.$context;
    const old = await internalAdapter.findUserByEmail(testEmail);
    await internalAdapter.deleteUser(old?.user.id ?? "");
    await auth.api.signUpEmail({
      body: { email: testEmail, name: operatorName, password: testPassword },
    });
    expect(scratch.storage).toBeDefined();
    // The address's tries from before have come back.
    tick(15 * 60 * 1000);
    const statuses = await tries(11, tick, () =>
      signIn(auth, { body: wrong, cookie })
    );
    expect(statuses).toEqual([...new Array(10).fill(401), 429]);
  });
});

describe("a try from a browser not known for the account", () => {
  test("one the install's checks a second refuse spends none of the account's ten", async () => {
    const { auth, tick } = await install();
    tick();
    for (let each = 0; each < 5; each += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: within one second, as a flood sends them
      await signIn(auth, {
        body: { email: `guess${each}@example.com`, password: "x".repeat(12) },
      });
    }
    // The sixth this second is refused by the install's ceiling, not the account's count.
    for (let each = 0; each < 5; each += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: within the same second
      expect((await signIn(auth, { body: wrong })).status).toBe(429);
    }
    // The account still has all ten.
    expect(await tries(11, tick, () => signIn(auth, { body: wrong }))).toEqual([
      ...new Array(10).fill(401),
      429,
    ]);
  });

  test("past the account's ten the answer says when to try again, the same for an address with no account", async () => {
    const { auth, tick } = await install();
    const made = { email: "nobody@example.com", password: "x".repeat(12) };
    // The same tries at the same times, so only having an account could tell them apart.
    await tries(10, tick, () =>
      Promise.all([
        signIn(auth, { body: wrong }),
        signIn(auth, { body: made }),
      ]).then(([first]) => first)
    );
    tick();
    const [real, invented] = await Promise.all([
      signIn(auth, { body: wrong }),
      signIn(auth, { body: made }),
    ]);
    expect(real.status).toBe(429);
    expect(Number(real.headers.get("retry-after"))).toBeGreaterThan(0);
    expect([invented.status, invented.headers.get("retry-after")]).toEqual([
      real.status,
      real.headers.get("retry-after"),
    ]);
    expect(await invented.json()).toEqual(await real.json());
  });
});

describe("what a typed address may cost", () => {
  test("one that could not be an email, past Better Auth's 254 characters, is never counted and stores nothing, however many arrive; one of 254 is counted", async () => {
    const { auth, browsers, tick } = await install();
    const long = (n: number) => `${"a".repeat(60_000)}${n}@example.com`;
    const statuses = await tries(12, tick, () =>
      signIn(auth, { body: { email: long(1), password: "x".repeat(12) } })
    );
    // Better Auth refuses the address itself; the counts never saw it.
    expect(statuses).toEqual(new Array(12).fill(400));
    for (let each = 0; each < 50; each += 1) {
      tick();
      // biome-ignore lint/performance/noAwaitInLoops: one after another, as a flood sends them
      await signIn(auth, {
        body: { email: long(each), password: "x".repeat(12) },
      });
    }
    // A fresh install's counts hold nothing until a plausible address is typed.
    expect(browsers.size()).toBe(0);
    const longest = `${"a".repeat(242)}@example.com`;
    expect(longest).toHaveLength(254);
    const counted = await tries(11, tick, () =>
      signIn(auth, { body: { email: longest, password: "x".repeat(12) } })
    );
    expect(counted.at(-1)).toBe(429);
  });

  test("when the counts are full, a new address shares one ten with every other and the install's five a second still hold", () => {
    const browsers = createKnownBrowsers(() => 1_000_000);
    // Only a unit fills them: ten thousand accounts' wrong passwords in one instant.
    for (let each = 0; each < 10_000; each += 1) {
      browsers.countWrong({ account: `account-${each}` });
    }
    const allowed = Array.from({ length: 50 }, () =>
      browsers.guessWait("new@example.com")
    ).filter((wait) => wait === 0);
    expect(allowed).toHaveLength(5);
  });
});
