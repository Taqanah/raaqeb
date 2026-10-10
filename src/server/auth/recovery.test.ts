import { afterEach, describe, expect, test } from "bun:test";
import { runSql } from "@/server/storage/fixture.ts";
import {
  createAuth,
  mailSettled,
  operatorName,
  resetLinkOf,
  resetPagePath,
} from "./auth.ts";
import {
  authWithOperator,
  call,
  capturingMail,
  cookiesOf,
  type Scratch,
  scratchStorage,
  setsSession,
  signIn,
  testEmail,
  testOrigin,
  testSecrets,
} from "./fixture.ts";
import { authMailOver } from "./mail.ts";

// Password recovery with email: "forgot password" through Better
// Auth's core request endpoint, the link to the set-new-password page, and
// the reset that ends every session and forgets every trusted browser. Over
// the handler, on both backends.

let open: Scratch | undefined;
async function scratch(): Promise<Scratch> {
  open = await scratchStorage();
  return open;
}
afterEach(async () => {
  await open?.cleanup();
  open = undefined;
});

const tokenOf = (link: string) => new URL(link).searchParams.get("token") ?? "";
const newPassword = "a brand new password";

describe("forgot password", () => {
  test("emails the operator a reset link to the set-new-password page, carrying a one-time token", async () => {
    const { storage } = await scratch();
    const { mail, sent } = capturingMail();
    const auth = await authWithOperator(storage, mail);
    const response = await call(auth, "/request-password-reset", {
      body: { email: testEmail },
    });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message?.kind).toBe("reset_link");
    expect(message?.to).toBe(testEmail);
    const link = new URL(message?.value ?? "");
    expect(link.origin).toBe(testOrigin);
    expect(link.pathname).toBe(resetPagePath);
    expect(tokenOf(message?.value ?? "").length).toBeGreaterThanOrEqual(24);
    expect(resetLinkOf(testOrigin, "abc")).toBe(
      `${testOrigin}${resetPagePath}?token=abc`
    );
  });

  test("answers the same for an address that is not the account's, and sends nothing", async () => {
    const { storage } = await scratch();
    const { mail, sent } = capturingMail();
    const auth = await authWithOperator(storage, mail);
    const response = await call(auth, "/request-password-reset", {
      body: { email: "someone@example.org" },
    });
    expect(response.status).toBe(200);
    expect(sent).toEqual([]);
  });

  test("while the email channel fails, the operator's address and an unknown one get the same answer", async () => {
    const { storage } = await scratch();
    const { mail } = capturingMail({ failResetLink: true });
    const auth = await authWithOperator(storage, mail);
    const operator = await call(auth, "/request-password-reset", {
      body: { email: testEmail },
    });
    const unknown = await call(auth, "/request-password-reset", {
      body: { email: "someone@example.org" },
    });
    expect(operator.status).toBe(unknown.status);
    expect(await operator.text()).toBe(await unknown.text());
  });

  test("answers the operator's address before the reset link's send ends, so the time does not tell the account's address", async () => {
    const { storage } = await scratch();
    const held = Promise.withResolvers<void>();
    let sent = false;
    const auth = await authWithOperator(storage, {
      code: () => Promise.resolve(),
      resetLink: async () => {
        await held.promise;
        sent = true;
      },
    });
    const answering = call(auth, "/request-password-reset", {
      body: { email: testEmail },
    });
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
    }
  });

  test("the stop path's wait lasts until a reset link handed off has been sent", async () => {
    const { storage } = await scratch();
    const held = Promise.withResolvers<void>();
    let sent = false;
    const auth = await authWithOperator(storage, {
      code: () => Promise.resolve(),
      resetLink: async () => {
        await held.promise;
        sent = true;
      },
    });
    const answering = call(auth, "/request-password-reset", {
      body: { email: testEmail },
    });
    // Released after one second, so a build that waits for the send still answers.
    const release = setTimeout(() => held.resolve(), 1000);
    await answering;
    const settling = mailSettled();
    const state = await Promise.race([
      settling.then(() => "settled" as const),
      Bun.sleep(50).then(() => "waiting" as const),
    ]);
    held.resolve();
    clearTimeout(release);
    await Promise.all([answering, settling]);
    expect(state).toBe("waiting");
    expect(sent).toBe(true);
  });

  test("the stop path's wait also lasts for a reset link handed off while it is already waiting", async () => {
    const { storage } = await scratch();
    const holds = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const finished: number[] = [];
    let started = 0;
    const auth = await authWithOperator(storage, {
      code: () => Promise.resolve(),
      resetLink: async () => {
        const index = started;
        started += 1;
        await holds[index]?.promise;
        finished.push(index);
      },
    });
    const request = () =>
      call(auth, "/request-password-reset", { body: { email: testEmail } });
    await request();
    const settling = mailSettled();
    // A request still in flight when the server stopped hands its send off now.
    await request();
    holds[0]?.resolve();
    const state = await Promise.race([
      settling.then(() => "settled" as const),
      Bun.sleep(50).then(() => "waiting" as const),
    ]);
    holds[1]?.resolve();
    await settling;
    expect(state).toBe("waiting");
    expect(finished).toEqual([0, 1]);
  });

  test("the token is Better Auth's core verification row, the same on both backends, and it is gone once used", async () => {
    const { location, storage } = await scratch();
    const { mail, sent } = capturingMail();
    const auth = await authWithOperator(storage, mail);
    await call(auth, "/request-password-reset", { body: { email: testEmail } });
    const token = tokenOf(sent[0]?.value ?? "");
    const rows = () =>
      runSql(
        location,
        "SELECT identifier, value FROM auth_verification WHERE identifier = ?",
        [`reset-password:${token}`]
      );
    const [row] = await rows();
    const [user] = await runSql(location, "SELECT id FROM auth_user");
    expect(row?.value).toBe(user?.id);
    await call(auth, "/reset-password", { body: { newPassword, token } });
    expect(await rows()).toEqual([]);
  });

  test("the fourth request in ten seconds from one address is refused, as a sign-in would be", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const address = "198.51.200.1";
    const body = { email: "nobody@example.org" };
    for (let i = 0; i < 3; i += 1) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: each request counts against the limit after the one before it
        (await call(auth, "/request-password-reset", { address, body })).status
      ).toBe(200);
    }
    expect(
      (await call(auth, "/request-password-reset", { address, body })).status
    ).toBe(429);
  });
});

describe("a reset link that could not go", () => {
  test("is logged once, by the reason, never with the token or the link", async () => {
    const { boot, location, storage } = await scratch();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    // No email channel exists, so the send fails the way a refusing channel does.
    const auth = createAuth({
      baseURL: testOrigin,
      database: storage.authDatabase,
      log,
      mail: authMailOver(
        storage,
        boot.installKey,
        { fetch, now: Date.now },
        log
      ),
      secrets: testSecrets,
    });
    await auth.api.signUpEmail({
      body: { email: testEmail, name: operatorName, password: "a password" },
    });
    const response = await call(auth, "/request-password-reset", {
      body: { email: testEmail },
    });
    expect(response.status).toBe(200);
    // The send runs after the answer; the log line comes when it ends.
    await mailSettled();
    const [row] = await runSql(
      location,
      "SELECT identifier FROM auth_verification WHERE identifier LIKE 'reset-password:%'"
    );
    const token = String(row?.identifier ?? "").slice("reset-password:".length);
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(lines).toEqual(["the reset link was not sent: no email channel"]);
    expect(lines.join("\n")).not.toContain(token);
  });

  test("a send that throws after the answer is logged by Better Auth, never left unhandled", async () => {
    const { storage } = await scratch();
    const lines: string[] = [];
    const auth = createAuth({
      baseURL: testOrigin,
      database: storage.authDatabase,
      log: (line) => lines.push(line),
      mail: {
        code: () => Promise.resolve(),
        resetLink: async () => {
          await Bun.sleep(10);
          throw new Error("the transport broke");
        },
      },
      secrets: testSecrets,
    });
    await auth.api.signUpEmail({
      body: { email: testEmail, name: operatorName, password: "a password" },
    });
    const response = await call(auth, "/request-password-reset", {
      body: { email: testEmail },
    });
    expect(response.status).toBe(200);
    expect(lines).toEqual([]);
    await mailSettled();
    expect(lines).toEqual(["better-auth: Failed to run background task:"]);
  });

  test("without a stored public address there is no link to make, and the request answers as for any address", async () => {
    const { storage } = await scratch();
    const { mail, sent } = capturingMail();
    const lines: string[] = [];
    const auth = createAuth({
      baseURL: undefined,
      database: storage.authDatabase,
      log: (line) => lines.push(line),
      mail,
      secrets: testSecrets,
    });
    await auth.api.signUpEmail({
      body: {
        email: testEmail,
        name: operatorName,
        password: "correct horse battery",
      },
    });
    const response = await call(auth, "/request-password-reset", {
      body: { email: testEmail },
    });
    expect(response.status).toBe(200);
    expect(sent).toEqual([]);
    expect(lines).toEqual([
      "the reset link was not sent: no public address is stored",
    ]);
  });
});

describe("the set-new-password page's reset", () => {
  test("sets the password once: the old one stops working, the new one signs in, and the link is spent", async () => {
    const { storage } = await scratch();
    const { mail, sent } = capturingMail();
    const auth = await authWithOperator(storage, mail);
    await call(auth, "/request-password-reset", { body: { email: testEmail } });
    const token = tokenOf(sent[0]?.value ?? "");
    const reset = await call(auth, "/reset-password", {
      body: { newPassword, token },
    });
    expect(reset.status).toBe(200);
    // No sign-in follows the reset.
    expect(setsSession(reset)).toBe(false);
    expect((await signIn(auth)).status).toBe(401);
    expect((await signIn(auth, { password: newPassword })).status).toBe(200);
    const again = await call(auth, "/reset-password", {
      body: { newPassword: "yet another password", token },
    });
    expect(again.status).toBe(400);
  });

  test("a token that is not one is refused", async () => {
    const { storage } = await scratch();
    const auth = await authWithOperator(storage);
    const response = await call(auth, "/reset-password", {
      body: { newPassword, token: "not-a-token" },
    });
    expect(response.status).toBe(400);
  });

  test("a password under eight characters is refused and the link stays usable", async () => {
    const { storage } = await scratch();
    const { mail, sent } = capturingMail();
    const auth = await authWithOperator(storage, mail);
    await call(auth, "/request-password-reset", { body: { email: testEmail } });
    const token = tokenOf(sent[0]?.value ?? "");
    const short = await call(auth, "/reset-password", {
      body: { newPassword: "short", token },
    });
    expect(short.status).toBe(400);
    const reset = await call(auth, "/reset-password", {
      body: { newPassword, token },
    });
    expect(reset.status).toBe(200);
  });

  test("ends every session and forgets every trusted browser", async () => {
    const { location, storage } = await scratch();
    const { mail, sent } = capturingMail();
    const auth = await authWithOperator(storage, mail);
    // A session, and a trusted browser through the second step.
    const first = await signIn(auth);
    const session = cookiesOf(first);
    await auth.api.enableTwoFactor({
      body: { method: "otp", password: "correct horse battery" },
      headers: new Headers({ cookie: session }),
    });
    const pending = cookiesOf(await signIn(auth));
    await call(auth, "/two-factor/send-otp", { body: {}, cookie: pending });
    const code = sent.find((m) => m.kind === "code")?.value ?? "";
    const verified = await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: true },
      cookie: pending,
    });
    expect(verified.status).toBe(200);
    const trusted = () =>
      runSql(
        location,
        "SELECT identifier FROM auth_verification WHERE identifier LIKE 'trust-device-%'"
      );
    const sessions = () => runSql(location, "SELECT id FROM auth_session");
    expect(await trusted()).toHaveLength(1);
    expect((await sessions()).length).toBeGreaterThanOrEqual(1);
    await call(auth, "/request-password-reset", { body: { email: testEmail } });
    const token = tokenOf(
      sent.findLast((m) => m.kind === "reset_link")?.value ?? ""
    );
    expect(
      (await call(auth, "/reset-password", { body: { newPassword, token } }))
        .status
    ).toBe(200);
    expect(await sessions()).toEqual([]);
    expect(await trusted()).toEqual([]);
    // The second step stays on: the email path leaves the switch alone.
    const [user] = await runSql(
      location,
      "SELECT two_factor_enabled FROM auth_user"
    );
    expect(Number(user?.two_factor_enabled)).toBe(1);
  });
});
