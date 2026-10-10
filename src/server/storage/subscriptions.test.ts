import { afterEach, describe, expect, test } from "bun:test";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import {
  confirmationCooldownMs,
  confirmationLifetimeMs,
} from "@/shared/schemas/subscription.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { type PagesRepository, pagesRepository } from "./pages.ts";
import type { DatabaseLocation } from "./storage.ts";
import {
  type SubscriptionRequest,
  SubscriptionShapeError,
  type SubscriptionsRepository,
  subscriptionsRepository,
} from "./subscriptions.ts";

let open: { connection: Connection; cleanup: () => Promise<void> } | undefined;

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const byText = (a: string, b: string) => a.localeCompare(b);

const t0 = 1_700_000_000_000;

async function repositories(): Promise<{
  location: DatabaseLocation;
  pages: PagesRepository;
  subscriptions: SubscriptionsRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection };
  await migrateDatabase(connection);
  const run = executor(connection);
  let ids = 0;
  let tokens = 0;
  return {
    location: scratch.location,
    pages: pagesRepository(run, () => t0),
    subscriptions: subscriptionsRepository(
      run,
      () => {
        ids += 1;
        return `sub-${String(ids).padStart(3, "0")}`;
      },
      () => {
        tokens += 1;
        return `token-${String(tokens).padStart(3, "0")}`;
      }
    ),
  };
}

async function page(repos: { pages: PagesRepository }, slug = "main") {
  return await repos.pages.create({
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: false,
    published: true,
    locale: "ar",
    slug,
    title: { ar: slug },
  });
}

function signUp(
  pageId: string,
  overrides: Partial<SubscriptionRequest> = {}
): SubscriptionRequest {
  return {
    address: "reader@example.test",
    channel: "email",
    credentials: undefined,
    locale: "ar",
    pageId,
    quietSince: t0 - confirmationCooldownMs,
    requestedAt: t0,
    ...overrides,
  };
}

/** The value, or a failed test when there is none. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

describe("the subscriptions table", () => {
  test("a sign-up stores a pending subscription with its token, language and confirmation time", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    const stored = defined(
      await repos.subscriptions.request(
        signUp(pageId, { credentials: "sealed", locale: "en" })
      )
    );
    expect(stored).toEqual({
      address: "reader@example.test",
      channel: "email",
      confirmedAt: undefined,
      createdAt: t0,
      credentials: "sealed",
      id: "sub-001",
      locale: "en",
      pageId,
      requestedAt: t0,
      status: "pending",
      token: "token-001",
    });
    expect(await repos.subscriptions.find(stored.id)).toEqual(stored);
    expect(await repos.subscriptions.byToken("token-001")).toEqual(stored);
    expect(await repos.subscriptions.find("nothing")).toBeUndefined();
    expect(await repos.subscriptions.byToken("nothing")).toBeUndefined();
  });

  test("a second sign-up of a pending address asks for no confirmation until the last one is ten minutes old, then keeps the token", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    await repos.subscriptions.request(signUp(pageId));
    const soon = t0 + confirmationCooldownMs - 1;
    expect(
      await repos.subscriptions.request(
        signUp(pageId, {
          quietSince: soon - confirmationCooldownMs,
          requestedAt: soon,
        })
      )
    ).toBeUndefined();
    const later = t0 + confirmationCooldownMs;
    const again = defined(
      await repos.subscriptions.request(
        signUp(pageId, {
          locale: "en",
          quietSince: later - confirmationCooldownMs,
          requestedAt: later,
        })
      )
    );
    expect(again).toMatchObject({
      createdAt: t0,
      id: "sub-001",
      locale: "en",
      requestedAt: later,
      status: "pending",
      token: "token-001",
    });
    expect(
      await runSql(repos.location, "SELECT id FROM subscriptions")
    ).toEqual([{ id: "sub-001" }]);
  });

  test("a confirmed subscription asks for no confirmation when its address signs up again", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    await repos.subscriptions.request(signUp(pageId));
    await repos.subscriptions.confirm("token-001", t0 + 1, t0 - 1);
    const later = t0 + confirmationLifetimeMs;
    expect(
      await repos.subscriptions.request(
        signUp(pageId, {
          quietSince: later - confirmationCooldownMs,
          requestedAt: later,
        })
      )
    ).toBeUndefined();
    expect(await repos.subscriptions.byToken("token-001")).toMatchObject({
      confirmedAt: t0 + 1,
      requestedAt: t0,
      status: "confirmed",
    });
  });

  test("an unsubscribed address that signs up again is pending once more, with its old token", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    await repos.subscriptions.request(signUp(pageId));
    await repos.subscriptions.confirm("token-001", t0 + 1, t0 - 1);
    await repos.subscriptions.unsubscribe("token-001");
    const later = t0 + confirmationLifetimeMs;
    const again = defined(
      await repos.subscriptions.request(
        signUp(pageId, {
          credentials: "sealed again",
          quietSince: later - confirmationCooldownMs,
          requestedAt: later,
        })
      )
    );
    expect(again).toMatchObject({
      confirmedAt: undefined,
      credentials: "sealed again",
      requestedAt: later,
      status: "pending",
      token: "token-001",
    });
  });

  test("the same address on another page or through another channel is another subscription", async () => {
    const repos = await repositories();
    const first = await page(repos, "first");
    const second = await page(repos, "second");
    const a = await repos.subscriptions.request(signUp(first.id));
    const b = await repos.subscriptions.request(signUp(second.id));
    const c = await repos.subscriptions.request(
      signUp(first.id, { channel: "webhook" })
    );
    expect([a?.id, b?.id, c?.id]).toEqual(["sub-001", "sub-002", "sub-003"]);
  });

  test("confirming moves a pending subscription whose link was sent after the bound, and nothing else", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    await repos.subscriptions.request(signUp(pageId));
    // The link was sent at t0; a bound at t0 means it is too old.
    expect(await repos.subscriptions.confirm("token-001", t0 + 5, t0)).toBe(
      false
    );
    expect(await repos.subscriptions.confirm("token-001", t0 + 5, t0 - 1)).toBe(
      true
    );
    expect(await repos.subscriptions.byToken("token-001")).toMatchObject({
      confirmedAt: t0 + 5,
      status: "confirmed",
    });
    expect(await repos.subscriptions.confirm("token-001", t0 + 6, t0 - 1)).toBe(
      false
    );
    expect(await repos.subscriptions.byToken("token-001")).toMatchObject({
      confirmedAt: t0 + 5,
    });
    await repos.subscriptions.unsubscribe("token-001");
    expect(await repos.subscriptions.confirm("token-001", t0 + 7, t0 - 1)).toBe(
      false
    );
    expect(await repos.subscriptions.confirm("unknown", t0, t0 - 1)).toBe(
      false
    );
  });

  test("unsubscribing moves a pending or confirmed subscription, once", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    await repos.subscriptions.request(signUp(pageId));
    await repos.subscriptions.request(
      signUp(pageId, { address: "other@example.test" })
    );
    await repos.subscriptions.confirm("token-002", t0 + 1, t0 - 1);
    expect(await repos.subscriptions.unsubscribe("token-001")).toBe(true);
    expect(await repos.subscriptions.unsubscribe("token-002")).toBe(true);
    expect(await repos.subscriptions.unsubscribe("token-002")).toBe(false);
    expect(await repos.subscriptions.unsubscribe("unknown")).toBe(false);
    const statuses = (await repos.subscriptions.list(pageId)).map(
      (each) => each.status
    );
    expect(statuses).toEqual(["unsubscribed", "unsubscribed"]);
  });

  test("the confirmed subscriptions of some pages are theirs alone, never a pending or unsubscribed one", async () => {
    const repos = await repositories();
    const first = await page(repos, "first");
    const second = await page(repos, "second");
    const third = await page(repos, "third");
    const address = (n: number) => `reader${n}@example.test`;
    for (const [n, pageId] of [
      first.id,
      first.id,
      first.id,
      second.id,
      third.id,
    ].entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: the tokens follow the order of the sign-ups
      await repos.subscriptions.request(
        signUp(pageId, { address: address(n) })
      );
    }
    await repos.subscriptions.confirm("token-001", t0, t0 - 1);
    await repos.subscriptions.confirm("token-003", t0, t0 - 1);
    await repos.subscriptions.unsubscribe("token-003");
    await repos.subscriptions.confirm("token-004", t0, t0 - 1);
    await repos.subscriptions.confirm("token-005", t0, t0 - 1);
    const confirmed = await repos.subscriptions.confirmed([
      first.id,
      second.id,
    ]);
    expect(confirmed.map((each) => each.token).toSorted(byText)).toEqual([
      "token-001",
      "token-004",
    ]);
    expect(await repos.subscriptions.confirmed([])).toEqual([]);
  });

  test("expiring deletes the pending subscriptions whose link went before the bound, and nothing else", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    await repos.subscriptions.request(signUp(pageId));
    await repos.subscriptions.request(
      signUp(pageId, { address: "b@example.test", requestedAt: t0 + 10 })
    );
    await repos.subscriptions.request(
      signUp(pageId, { address: "c@example.test" })
    );
    await repos.subscriptions.confirm("token-003", t0 + 1, t0 - 1);
    await repos.subscriptions.request(
      signUp(pageId, { address: "d@example.test" })
    );
    await repos.subscriptions.unsubscribe("token-004");
    expect(await repos.subscriptions.expire(t0 + 10)).toBe(1);
    const left = (await repos.subscriptions.list(pageId)).map(
      (each) => each.token
    );
    expect(left.toSorted(byText)).toEqual([
      "token-002",
      "token-003",
      "token-004",
    ]);
  });

  test("the page's subscriptions list newest first, and removing one takes that one of that page alone", async () => {
    const repos = await repositories();
    const first = await page(repos, "first");
    const second = await page(repos, "second");
    await repos.subscriptions.request(signUp(first.id));
    await repos.subscriptions.request(
      signUp(first.id, { address: "b@example.test", requestedAt: t0 + 5 })
    );
    await repos.subscriptions.request(signUp(second.id));
    expect(
      (await repos.subscriptions.list(first.id)).map((each) => each.id)
    ).toEqual(["sub-002", "sub-001"]);
    expect(await repos.subscriptions.remove(second.id, "sub-001")).toBe(false);
    expect(await repos.subscriptions.remove(first.id, "sub-001")).toBe(true);
    expect(await repos.subscriptions.remove(first.id, "sub-001")).toBe(false);
    expect(
      (await repos.subscriptions.list(first.id)).map((each) => each.id)
    ).toEqual(["sub-002"]);
  });

  test("a page deleted takes its subscriptions with it", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    await repos.subscriptions.request(signUp(pageId));
    await repos.pages.remove(pageId);
    expect(await repos.subscriptions.find("sub-001")).toBeUndefined();
  });

  test("the database refuses a second subscription of one address through one channel on one page, and a token used twice", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    await repos.subscriptions.request(signUp(pageId));
    const insert = (id: string, address: string, token: string) =>
      runSql(
        repos.location,
        "INSERT INTO subscriptions (id, page_id, channel, address, locale, token, status, requested_at, created_at) VALUES (?, ?, 'email', ?, 'ar', ?, 'pending', 0, 0)",
        [id, pageId, address, token]
      );
    await expect(
      insert("sub-x", "reader@example.test", "token-x")
    ).rejects.toThrow();
    await expect(
      insert("sub-y", "other@example.test", "token-001")
    ).rejects.toThrow();
  });

  test("a stored subscription this version cannot read is named", async () => {
    const repos = await repositories();
    const { id: pageId } = await page(repos);
    await repos.subscriptions.request(signUp(pageId));
    await runSql(repos.location, "UPDATE subscriptions SET channel = 'sms'");
    await expect(repos.subscriptions.find("sub-001")).rejects.toBeInstanceOf(
      SubscriptionShapeError
    );
    await expect(repos.subscriptions.list(pageId)).rejects.toThrow("sub-001");
  });
});
