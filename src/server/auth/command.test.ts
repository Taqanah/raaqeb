import { afterEach, describe, expect, test } from "bun:test";
import { publicAddress } from "@/server/settings/address.ts";
import { runSql } from "@/server/storage/fixture.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { type Auth, authFor } from "./auth.ts";
import { resetPasswordCommand, type Terminal } from "./command.ts";
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
  testPassword,
} from "./fixture.ts";
import { confirmApp, setUpApp } from "./second-step.ts";

// `raaqeb reset-password`: the same core token as "forgot
// password", printed as a link, or set at once with `--interactive`; the
// second step switched off with its authenticator app. Over a scratch database, on both
// backends; the entry test runs it beside a live server.

let open: Scratch | undefined;
async function scratch(): Promise<Scratch> {
  open = await scratchStorage();
  return open;
}
afterEach(async () => {
  await open?.cleanup();
  open = undefined;
});

interface Script {
  readonly hidden?: readonly string[];
  readonly interactive?: boolean;
}

/** A terminal that answers from a script and keeps what was printed. */
function terminal(script: Script = {}): Terminal & {
  /** The questions asked without echo, the only kind the terminal has. */
  readonly askedHidden: string[];
  readonly errors: string[];
  readonly lines: string[];
} {
  const hidden = [...(script.hidden ?? [])];
  const askedHidden: string[] = [];
  const errors: string[] = [];
  const lines: string[] = [];
  return {
    askHidden: (question) => {
      askedHidden.push(question);
      return Promise.resolve(hidden.shift() ?? "");
    },
    askedHidden,
    err: (line) => {
      errors.push(line);
    },
    errors,
    interactive: script.interactive ?? true,
    lines,
    out: (line) => {
      lines.push(line);
    },
  };
}

const linkIn = (lines: string[]) =>
  lines.find((l) => l.includes("/reset-password?token="));
const tokenOf = (link: string) => new URL(link).searchParams.get("token") ?? "";

async function secondStepOn(storage: Storage): Promise<Auth> {
  const auth = await authWithOperator(storage, capturingMail().mail);
  const session = cookiesOf(await signIn(auth));
  await auth.api.enableTwoFactor({
    body: { method: "otp", password: testPassword },
    headers: new Headers({ cookie: session }),
  });
  return auth;
}

describe("the reset command", () => {
  test("prints a reset link whose token sets a new password through the install's own handler, and with the second step off says nothing about it", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const t = terminal();
    expect(
      await resetPasswordCommand(s.storage, s.boot, { interactive: false }, t)
    ).toBe(0);
    expect(t.lines.join("\n")).not.toContain("second step");
    const link = linkIn(t.lines) ?? "";
    expect(link.startsWith("http://raaqeb.test/reset-password?token=")).toBe(
      true
    );
    const auth = await authFor(s.storage, s.boot);
    const reset = await call(auth, "/reset-password", {
      body: { newPassword: "a brand new password", token: tokenOf(link) },
    });
    expect(reset.status).toBe(200);
    expect(
      (await signIn(auth, { password: "a brand new password" })).status
    ).toBe(200);
  });

  test("interactive asks the new password twice without echo, sets it, and ends every session", async () => {
    const s = await scratch();
    const auth = await authWithOperator(s.storage);
    await signIn(auth);
    const t = terminal({
      hidden: ["a brand new password", "a brand new password"],
    });
    expect(
      await resetPasswordCommand(s.storage, s.boot, { interactive: true }, t)
    ).toBe(0);
    // Both through hidden input; the terminal has no echoed question.
    expect(t.askedHidden).toHaveLength(2);
    expect(linkIn(t.lines)).toBeUndefined();
    expect(t.lines.join("\n")).not.toContain("a brand new password");
    expect(await runSql(s.location, "SELECT id FROM auth_session")).toEqual([]);
    expect((await signIn(auth)).status).toBe(401);
    expect(
      (await signIn(auth, { password: "a brand new password" })).status
    ).toBe(200);
  });

  test("interactive passwords that differ, or one under eight characters, set nothing and exit 1", async () => {
    const s = await scratch();
    const auth = await authWithOperator(s.storage);
    const differ = terminal({ hidden: ["a brand new password", "another"] });
    expect(
      await resetPasswordCommand(
        s.storage,
        s.boot,
        { interactive: true },
        differ
      )
    ).toBe(1);
    const short = terminal({ hidden: ["short", "short"] });
    expect(
      await resetPasswordCommand(
        s.storage,
        s.boot,
        { interactive: true },
        short
      )
    ).toBe(1);
    expect((await signIn(auth)).status).toBe(200);
    expect(
      await runSql(
        s.location,
        "SELECT id FROM auth_verification WHERE identifier LIKE 'reset-password:%'"
      )
    ).toEqual([]);
  });

  test("interactive without a terminal exits 2 and mints nothing", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    const t = terminal({ interactive: false });
    expect(
      await resetPasswordCommand(s.storage, s.boot, { interactive: true }, t)
    ).toBe(2);
    expect(t.errors.join("\n")).toContain("--interactive");
    expect(
      await runSql(
        s.location,
        "SELECT id FROM auth_verification WHERE identifier LIKE 'reset-password:%'"
      )
    ).toEqual([]);
  });

  test("before onboarding there is no account to reset: exits 1 and says so", async () => {
    const s = await scratch();
    const t = terminal();
    expect(
      await resetPasswordCommand(s.storage, s.boot, { interactive: false }, t)
    ).toBe(1);
    expect(t.errors.join("\n")).toContain("no operator account");
  });

  test("without a stored public address there is no link to print: exits 1", async () => {
    const s = await scratch();
    await authWithOperator(s.storage);
    await s.storage.settings.remove(publicAddress);
    const t = terminal();
    expect(
      await resetPasswordCommand(s.storage, s.boot, { interactive: false }, t)
    ).toBe(1);
    expect(t.errors.join("\n")).toContain("public address");
  });

  test("while the second step is on it switches it off and removes the authenticator app without asking, since shell access proves ownership", async () => {
    const s = await scratch();
    const auth = await authWithOperator(s.storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    const setUp = await setUpApp(auth, headers, { password: testPassword });
    if (!setUp.ok) {
      throw new Error(setUp.reason);
    }
    await confirmApp(auth, headers, { code: appCode(setUp.uri) });
    const t = terminal();
    expect(
      await resetPasswordCommand(s.storage, s.boot, { interactive: false }, t)
    ).toBe(0);
    expect(t.askedHidden).toEqual([]);
    expect(await s.storage.operatorAccount.read()).toMatchObject({
      app: false,
      secondStep: false,
    });
    expect(await runSql(s.location, "SELECT id FROM auth_two_factor")).toEqual(
      []
    );
    expect(t.lines.join("\n")).toContain("The second step is off");
    expect(setsSession(await signIn(auth))).toBe(true);
  });

  test("the printed link's run switches the emailed second step off too", async () => {
    const s = await scratch();
    await secondStepOn(s.storage);
    const t = terminal();
    expect(
      await resetPasswordCommand(s.storage, s.boot, { interactive: false }, t)
    ).toBe(0);
    expect((await s.storage.operatorAccount.read())?.secondStep).toBe(false);
  });

  test("an app whose setup was left before its first code is removed too, without a word about a second step that was off", async () => {
    const s = await scratch();
    const auth = await authWithOperator(s.storage);
    const headers = new Headers({ cookie: cookiesOf(await signIn(auth)) });
    await setUpApp(auth, headers, { password: testPassword });
    const t = terminal();
    expect(
      await resetPasswordCommand(s.storage, s.boot, { interactive: false }, t)
    ).toBe(0);
    expect(await runSql(s.location, "SELECT id FROM auth_two_factor")).toEqual(
      []
    );
    expect(t.lines.join("\n")).not.toContain("second step");
  });

  test("interactive forgets every trusted browser too, since the reset runs Better Auth's hooks on the server", async () => {
    const s = await scratch();
    const mail = capturingMail();
    const auth = await authWithOperator(s.storage, mail.mail);
    const session = cookiesOf(await signIn(auth));
    await auth.api.enableTwoFactor({
      body: { method: "otp", password: testPassword },
      headers: new Headers({ cookie: session }),
    });
    const pending = cookiesOf(await signIn(auth));
    await call(auth, "/two-factor/send-otp", { body: {}, cookie: pending });
    const code = mail.sent.findLast((m) => m.kind === "code")?.value ?? "";
    await call(auth, "/two-factor/verify-otp", {
      body: { code, trustDevice: true },
      cookie: pending,
    });
    const trusted = () =>
      runSql(
        s.location,
        "SELECT id FROM auth_verification WHERE identifier LIKE 'trust-device-%'"
      );
    expect(await trusted()).toHaveLength(1);
    const t = terminal({
      hidden: ["a brand new password", "a brand new password"],
    });
    expect(
      await resetPasswordCommand(s.storage, s.boot, { interactive: true }, t)
    ).toBe(0);
    expect(await trusted()).toEqual([]);
  });

  test("a database that fails after the command wrote does not claim nothing changed", async () => {
    const s = await scratch();
    await secondStepOn(s.storage);
    const failing: Storage = {
      ...s.storage,
      operatorAccount: {
        ...s.storage.operatorAccount,
        secondStepOff: () =>
          Promise.reject(new Error("the database went away")),
      },
    };
    const t = terminal();
    expect(
      await resetPasswordCommand(failing, s.boot, { interactive: false }, t)
    ).toBe(1);
    expect(t.errors.join("\n")).not.toContain("nothing was changed");
  });
});
