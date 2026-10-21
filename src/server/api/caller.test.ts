import { afterEach, describe, expect, test } from "bun:test";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { Role } from "@/shared/domain/roles.ts";
import { callerOfRequest, heldCaller, lastUsedEveryMs } from "./caller.ts";
import { hashApiKey } from "./keys.ts";
import { createRateLimit, type RateLimit } from "./limit.ts";

let open: { storage: Storage; cleanup: () => Promise<void> } | undefined;

async function storage(): Promise<{
  store: Storage;
  location: DatabaseLocation;
}> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = { cleanup: scratch.cleanup, storage: opened.storage };
  return { location: scratch.location, store: opened.storage };
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

const secret = "rqk_the-key-the-test-holds";

/** An account of the role holding one key of `keyRole`, its secret `secret`. */
async function holder(
  location: DatabaseLocation,
  store: Storage,
  over: {
    readonly expiresAt?: number | null;
    readonly keyRole?: Role;
    readonly role?: Role;
    readonly secondStep?: boolean;
  } = {}
): Promise<void> {
  await runSql(
    location,
    "INSERT INTO auth_user (id, name, email, email_verified, two_factor_enabled, role, created_at, updated_at) VALUES ('a', 'Amal', 'amal@example.com', 0, ?, ?, 1000, 1000)",
    [over.secondStep ? 1 : 0, over.role ?? "admin"]
  );
  await store.apiKeys.create({
    accountId: "a",
    createdAt: 1000,
    expiresAt: over.expiresAt ?? null,
    id: "k1",
    name: "deploy",
    role: over.keyRole ?? "editor",
    tokenHash: hashApiKey(secret),
  });
}

/** An API request as the entry hands it on, with the client address it resolved. */
function call(authorization?: string, address = "203.0.113.9"): Request {
  const headers = new Headers({ [clientAddressHeader]: address });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request("http://raaqeb.test/api/v1/monitors", { headers });
}

const roomy = (): RateLimit => createRateLimit({ burst: 100, perSecond: 1 });
const refused = { ok: false, reason: "unauthenticated" } as const;

describe("an API call's caller", () => {
  test("is the key's account, with the key's role and the key named, and no session", async () => {
    const { location, store } = await storage();
    await holder(location, store, { secondStep: true });
    expect(
      await callerOfRequest(store, call(`Bearer ${secret}`), 2000, roomy())
    ).toEqual({
      ok: true,
      operator: {
        apiKey: { id: "k1", name: "deploy" },
        email: "amal@example.com",
        id: "a",
        name: "Amal",
        preferences: {},
        role: "editor",
        secondStep: true,
        sessionId: undefined,
        signedInWith: "password",
      },
    });
  });

  test("does the account's role when the account is below the key's", async () => {
    const { location, store } = await storage();
    await holder(location, store, { keyRole: "admin", role: "admin" });
    await runSql(location, "UPDATE auth_user SET role = 'viewer'");
    const caller = await callerOfRequest(
      store,
      call(`Bearer ${secret}`),
      2000,
      roomy()
    );
    expect(caller.ok && caller.operator.role).toBe("viewer");
  });

  test("is none without the header, with another scheme, or with a key no one holds", async () => {
    const { location, store } = await storage();
    await holder(location, store);
    const callers = await Promise.all(
      [
        undefined,
        `Basic ${secret}`,
        "Bearer",
        "Bearer rqk_another",
        secret,
      ].map((header) => callerOfRequest(store, call(header), 2000, roomy()))
    );
    expect(callers).toEqual(callers.map(() => refused));
  });

  test("is none once the key expired", async () => {
    const { location, store } = await storage();
    await holder(location, store, { expiresAt: 2000 });
    const at = (now: number) =>
      callerOfRequest(store, call(`Bearer ${secret}`), now, roomy());
    expect((await at(1999)).ok).toBe(true);
    expect(await at(2000)).toEqual(refused);
  });

  test("is none once the key was revoked", async () => {
    const { location, store } = await storage();
    await holder(location, store);
    await store.apiKeys.revoke("k1");
    expect(
      await callerOfRequest(store, call(`Bearer ${secret}`), 2000, roomy())
    ).toEqual(refused);
  });

  test("is none while its account is deactivated", async () => {
    const { location, store } = await storage();
    await holder(location, store);
    await runSql(location, "UPDATE auth_user SET deactivated_at = 1500");
    expect(
      await callerOfRequest(store, call(`Bearer ${secret}`), 2000, roomy())
    ).toEqual(refused);
  });

  test("is unavailable with no database, or one that cannot answer", async () => {
    const { location, store } = await storage();
    await holder(location, store);
    expect(
      await callerOfRequest(undefined, call(`Bearer ${secret}`), 2000, roomy())
    ).toEqual({ ok: false, reason: "unavailable" });
    const broken: Storage = {
      ...store,
      apiKeys: {
        ...store.apiKeys,
        open: () => Promise.reject(new Error("the database went away")),
      },
    };
    expect(
      await callerOfRequest(broken, call(`Bearer ${secret}`), 2000, roomy())
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  test("past the key's burst is rate limited, with the seconds until it may call again", async () => {
    const { location, store } = await storage();
    await holder(location, store);
    const limit = createRateLimit({ burst: 1, perSecond: 0.5 });
    expect(
      (await callerOfRequest(store, call(`Bearer ${secret}`), 2000, limit)).ok
    ).toBe(true);
    expect(
      await callerOfRequest(store, call(`Bearer ${secret}`), 2000, limit)
    ).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: 2 });
  });

  test("a key no one holds spends no one's limit", async () => {
    const { location, store } = await storage();
    await holder(location, store);
    const limit = createRateLimit({ burst: 1, perSecond: 1 });
    await callerOfRequest(store, call("Bearer rqk_another"), 2000, limit);
    expect(
      (await callerOfRequest(store, call(`Bearer ${secret}`), 2000, limit)).ok
    ).toBe(true);
  });

  test("records the key's last use at most once a minute from one address, at once from another", async () => {
    const { location, store } = await storage();
    await holder(location, store);
    const limit = roomy();
    const at = async (now: number, address?: string) => {
      await callerOfRequest(
        store,
        call(`Bearer ${secret}`, address),
        now,
        limit
      );
      return await store.apiKeys.find("k1");
    };
    expect(await at(2000)).toMatchObject({
      lastUsedAddress: "203.0.113.9",
      lastUsedAt: 2000,
    });
    expect(await at(2000 + lastUsedEveryMs - 1)).toMatchObject({
      lastUsedAt: 2000,
    });
    expect(await at(2000 + lastUsedEveryMs)).toMatchObject({
      lastUsedAt: 2000 + lastUsedEveryMs,
    });
    expect(await at(2000 + lastUsedEveryMs + 1, "198.51.100.4")).toMatchObject({
      lastUsedAddress: "198.51.100.4",
      lastUsedAt: 2000 + lastUsedEveryMs + 1,
    });
  });

  test("is read once a request, and held for the server functions that request calls", async () => {
    const { location, store } = await storage();
    await holder(location, store);
    const limit = createRateLimit({ burst: 1, perSecond: 1 });
    const request = call(`Bearer ${secret}`);
    expect(heldCaller(request)).toBeUndefined();
    const first = callerOfRequest(store, request, 2000, limit);
    expect(callerOfRequest(store, request, 2000, limit)).toBe(first);
    expect(heldCaller(request)).toBe(first);
    expect((await first).ok).toBe(true);
    // A request the API's route never read, a server function's own call among them, holds none.
    expect(heldCaller(call(`Bearer ${secret}`))).toBeUndefined();
  });
});
