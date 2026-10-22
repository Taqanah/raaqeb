import { afterEach, describe, expect, test } from "bun:test";
import { type Auth, createAuth } from "@/server/auth/auth.ts";
import {
  call,
  nextAddress,
  type Scratch,
  scratchStorage,
  silentMail,
  testEmail,
  testOrigin,
  testPassword,
  testSecrets,
} from "@/server/auth/fixture.ts";
import { retentionDays } from "@/server/settings/retention.ts";
import { auditPageSize } from "@/shared/schemas/audit.ts";
import { purgeAudit, readAuditLog, record } from "./audit.ts";

// The audit log over a scratch database, on both backends: entries written
// once and read newest first, filtered, paged and purged past retention,
// and the sign-in events Better Auth's handler records.

let open: Scratch | undefined;
async function scratch(): Promise<Scratch> {
  open = await scratchStorage();
  return open;
}
afterEach(async () => {
  await open?.cleanup();
  open = undefined;
});

const day = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;
const owner = { email: "owner@example.com", id: "owner" };
const editor = { email: "editor@example.com", id: "editor" };

describe("an audit entry", () => {
  test("is written with who, what, the record, the address and a detail without secrets, and read newest first", async () => {
    const s = await scratch();
    await record(s.storage, {
      action: "monitor.create",
      actor: owner,
      address: "203.0.113.7",
      input: { id: "m1", name: "API", password: "hunter2" },
      now,
    });
    await record(s.storage, {
      action: "channel.delete",
      actor: editor,
      address: undefined,
      input: { id: "c1" },
      now: now + 1,
    });
    const view = await readAuditLog(s.storage, {}, "UTC");
    expect(view?.entries.map((one) => one.action)).toEqual([
      "channel.delete",
      "monitor.create",
    ]);
    expect(view?.entries[1]).toMatchObject({
      actorEmail: "owner@example.com",
      actorId: "owner",
      address: "203.0.113.7",
      at: now,
      detail: { name: "API" },
      targetId: "m1",
    });
    expect(JSON.stringify(view)).not.toContain("hunter2");
    expect(view?.actors).toEqual([editor, owner]);
  });

  test("names the API key a change came through in its detail, and a session's carries none", async () => {
    const s = await scratch();
    await record(s.storage, {
      action: "monitor.pause",
      actor: owner,
      address: undefined,
      apiKey: "deploy script",
      input: { ids: ["m1"] },
      now,
    });
    await record(s.storage, {
      action: "monitor.resume",
      actor: owner,
      address: undefined,
      input: { ids: ["m1"] },
      now: now + 1,
    });
    const view = await readAuditLog(s.storage, {}, "UTC");
    expect(view?.entries[1]?.detail).toEqual({ via: "deploy script" });
    expect(view?.entries[0]?.detail).toEqual({});
  });

  test("is filtered by account and by kind, and paged back from a time", async () => {
    const s = await scratch();
    for (let index = 0; index < auditPageSize + 5; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one entry after another, in time order
      await record(s.storage, {
        action: index % 2 === 0 ? "monitor.change" : "page.change",
        actor: index % 3 === 0 ? editor : owner,
        address: undefined,
        input: {},
        now: now + index,
      });
    }
    const first = await readAuditLog(s.storage, {}, "UTC");
    expect(first?.entries).toHaveLength(auditPageSize);
    expect(first?.more).toBe(true);
    const rest = await readAuditLog(
      s.storage,
      { before: first?.entries.at(-1)?.at },
      "UTC"
    );
    expect(rest?.entries).toHaveLength(5);
    expect(rest?.more).toBe(false);
    const pages = await readAuditLog(s.storage, { kind: "page" }, "UTC");
    expect(pages?.entries.every((one) => one.action === "page.change")).toBe(
      true
    );
    const edits = await readAuditLog(s.storage, { actorId: "editor" }, "UTC");
    expect(edits?.entries.every((one) => one.actorId === "editor")).toBe(true);
  });

  test("is filtered to refused attempts alone, beside the other filters", async () => {
    const s = await scratch();
    const actions = ["sign_in.refuse", "sign_in.succeed", "monitor.change"];
    for (const [index, action] of actions.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: one entry after another, in time order
      await record(s.storage, {
        action,
        actor: undefined,
        address: undefined,
        input: {},
        now: now + index,
      });
    }
    const refused = await readAuditLog(s.storage, { refused: true }, "UTC");
    expect(refused?.entries.map((one) => one.action)).toEqual([
      "sign_in.refuse",
    ]);
    const none = await readAuditLog(
      s.storage,
      { kind: "monitor", refused: true },
      "UTC"
    );
    expect(none?.entries).toEqual([]);
  });

  test("is filtered to the days asked for in the operator's zone, the last day included", async () => {
    const s = await scratch();
    // 20:59, 21:00 and 23:00 UTC on 21 October: the first is still the 21st in Riyadh, the others the 22nd.
    const times = [
      Date.UTC(2026, 9, 21, 20, 59),
      Date.UTC(2026, 9, 21, 21),
      Date.UTC(2026, 9, 21, 23),
      Date.UTC(2026, 9, 22, 21),
    ];
    for (const at of times) {
      // biome-ignore lint/performance/noAwaitInLoops: one entry after another, in time order
      await record(s.storage, {
        action: "monitor.change",
        actor: owner,
        address: undefined,
        input: {},
        now: at,
      });
    }
    const oneDay = await readAuditLog(
      s.storage,
      { from: "2026-10-22", to: "2026-10-22" },
      "Asia/Riyadh"
    );
    expect(oneDay?.entries.map((one) => one.at)).toEqual([
      Date.UTC(2026, 9, 21, 23),
      Date.UTC(2026, 9, 21, 21),
    ]);
    const since = await readAuditLog(
      s.storage,
      { from: "2026-10-22" },
      "Asia/Riyadh"
    );
    expect(since?.entries).toHaveLength(3);
    const until = await readAuditLog(
      s.storage,
      { to: "2026-10-21" },
      "Asia/Riyadh"
    );
    expect(until?.entries.map((one) => one.at)).toEqual([
      Date.UTC(2026, 9, 21, 20, 59),
    ]);
  });

  test("goes once it is older than the install's retention, and not before", async () => {
    const s = await scratch();
    await s.storage.settings.set(retentionDays, 30);
    for (const at of [now - 31 * day, now - 29 * day]) {
      // biome-ignore lint/performance/noAwaitInLoops: two entries
      await record(s.storage, {
        action: "monitor.change",
        actor: owner,
        address: undefined,
        input: {},
        now: at,
      });
    }
    expect(await purgeAudit(s.storage, now)).toBe(1);
    expect(
      (await readAuditLog(s.storage, {}, "UTC"))?.entries.map((one) => one.at)
    ).toEqual([now - 29 * day]);
  });

  test("that cannot be written is logged, never thrown, and a log that cannot be read is nothing", async () => {
    const s = await scratch();
    await s.storage.close();
    await record(s.storage, {
      action: "monitor.change",
      actor: owner,
      address: undefined,
      input: {},
      now,
    });
    expect(await readAuditLog(s.storage, {}, "UTC")).toBeUndefined();
  });
});

describe("a sign-in over HTTP", () => {
  async function audited(s: Scratch): Promise<Auth> {
    const auth = createAuth({
      audit: (event) => record(s.storage, { ...event, now: Date.now() }),
      baseURL: testOrigin,
      database: s.storage.authDatabase,
      log: () => undefined,
      mail: silentMail,
      secrets: testSecrets,
    });
    await auth.api.signUpEmail({
      body: { email: testEmail, name: "", password: testPassword },
    });
    return auth;
  }

  test("is an entry naming the account and the address; a refused one names the email typed and never the password", async () => {
    const s = await scratch();
    const auth = await audited(s);
    const address = nextAddress();
    await call(auth, "/sign-in/email", {
      address,
      body: { email: testEmail, password: testPassword },
    });
    await call(auth, "/sign-in/email", {
      body: { email: "WHO@example.com", password: "a wrong password" },
    });
    const view = await readAuditLog(s.storage, { kind: "sign_in" }, "UTC");
    expect(view?.entries.map((one) => one.action)).toEqual([
      "sign_in.refuse",
      "sign_in.succeed",
    ]);
    expect(view?.entries[1]).toMatchObject({
      actorEmail: testEmail,
      address,
      detail: { method: "password" },
    });
    expect(view?.entries[0]).toMatchObject({
      actorId: null,
      detail: {
        email: "who@example.com",
        method: "password",
        reason: "INVALID_EMAIL_OR_PASSWORD",
      },
    });
    expect(JSON.stringify(view)).not.toContain("a wrong password");
  });
});
