import { afterEach, describe, expect, test } from "bun:test";
import type {
  NotificationPayload,
  SendFailure,
} from "@/shared/schemas/notification.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import type { SubscriberPayload } from "@/shared/schemas/subscription.ts";
import { type ChannelsRepository, channelsRepository } from "./channels.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import {
  laneOf,
  NotificationShapeError,
  type NotificationsRepository,
  notificationsRepository,
} from "./notifications.ts";
import { type PagesRepository, pagesRepository } from "./pages.ts";
import type { DatabaseLocation } from "./storage.ts";
import {
  type SubscriptionsRepository,
  subscriptionsRepository,
} from "./subscriptions.ts";

let open:
  | {
      connection: Connection;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

async function repositories(): Promise<{
  channels: ChannelsRepository;
  location: DatabaseLocation;
  notifications: NotificationsRepository;
  pages: PagesRepository;
  subscriptions: SubscriptionsRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection, location: scratch.location };
  await migrateDatabase(connection);
  const run = executor(connection);
  let nextId = 0;
  const newId = () => {
    nextId += 1;
    return `id-${String(nextId).padStart(3, "0")}`;
  };
  return {
    channels: channelsRepository(run, () => t0, newId),
    location: scratch.location,
    notifications: notificationsRepository(run, newId),
    pages: pagesRepository(run, () => t0, newId),
    subscriptions: subscriptionsRepository(run, newId, newId),
  };
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const t0 = 1_700_000_000_000;

/** The value, or a failed test when there is none. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

const down: NotificationPayload = {
  data: {
    monitor: {
      checkType: "http",
      id: "m1",
      name: "الموقع",
      target: "https://example.test/",
    },
    reason: "timeout",
  },
  timestamp: "2023-11-14T22:13:20.000Z",
  type: "monitor.down",
};

const refused: SendFailure = {
  error: "Unable to connect",
  params: {
    host: "hooks.example.test",
    port: 443,
    reason: "connection_refused",
  },
  reason: "connection_refused",
};

async function twoChannels(repos: { channels: ChannelsRepository }) {
  const fields = {
    appliesToNew: false,
    config: {},
    locale: undefined,
    type: "webhook" as const,
  };
  const a = await repos.channels.create({ ...fields, name: "a" });
  const b = await repos.channels.create({ ...fields, name: "b" });
  return { a: a.id, b: b.id };
}

describe("the notification queue's table", () => {
  test("queues one pending notification per channel, due when asked", async () => {
    const repos = await repositories();
    const { a, b } = await twoChannels(repos);
    const queued = await repos.notifications.enqueue(
      [a, b],
      "operator",
      down,
      t0
    );
    expect(queued.map(laneOf)).toEqual([a, b]);
    expect(queued[0]).toMatchObject({
      attempts: 0,
      failure: undefined,
      finishedAt: undefined,
      kind: "operator",
      nextAttemptAt: t0,
      payload: down,
      queuedAt: t0,
      status: "pending",
    });
    expect(await repos.notifications.nextDueAt()).toBe(t0);
    expect(await repos.notifications.enqueue([], "operator", down, t0)).toEqual(
      []
    );
  });

  test("nothing is due before its time, and an empty queue has no next due time", async () => {
    const repos = await repositories();
    expect(await repos.notifications.nextDueAt()).toBeUndefined();
    const { a } = await twoChannels(repos);
    await repos.notifications.enqueue([a], "operator", down, t0 + 5000);
    expect(await repos.notifications.due(t0, 4, [])).toEqual([]);
    expect(await repos.notifications.due(t0 + 5000, 4, [])).toHaveLength(1);
  });

  test("a channel sends its notifications in queue order: only its oldest pending one is due, even when a newer one is due earlier", async () => {
    const repos = await repositories();
    const { a, b } = await twoChannels(repos);
    const [first] = await repos.notifications.enqueue(
      [a],
      "operator",
      down,
      t0
    );
    await repos.notifications.enqueue([a], "operator", down, t0 + 1);
    await repos.notifications.enqueue([b], "operator", down, t0 + 2);
    await repos.notifications.settle(first?.id ?? "", {
      attempts: 1,
      failure: refused,
      nextAttemptAt: t0 + 30_000,
      status: "pending",
    });
    const due = await repos.notifications.due(t0 + 10_000, 4, []);
    expect(due.map(laneOf)).toEqual([b]);
    const later = await repos.notifications.due(t0 + 30_000, 4, []);
    const [newestOfB] = await repos.notifications.recent(b, 1);
    // Earliest due first: the other channel's waited since t0 + 2.
    expect(later.map((each) => each.id)).toEqual([
      defined(newestOfB).id,
      defined(first).id,
    ]);
  });

  test("the next due time is that of each channel's oldest pending notification, not of one waiting behind it", async () => {
    const repos = await repositories();
    const { a } = await twoChannels(repos);
    const [first] = await repos.notifications.enqueue(
      [a],
      "operator",
      down,
      t0
    );
    await repos.notifications.enqueue([a], "operator", down, t0 + 1);
    await repos.notifications.settle(defined(first).id, {
      attempts: 1,
      failure: refused,
      nextAttemptAt: t0 + 30_000,
      status: "pending",
    });
    expect(await repos.notifications.nextDueAt()).toBe(t0 + 30_000);
  });

  test("due answers at most the limit, earliest first, and leaves out the busy channels", async () => {
    const repos = await repositories();
    const { a, b } = await twoChannels(repos);
    await repos.notifications.enqueue([b], "operator", down, t0);
    await repos.notifications.enqueue([a], "operator", down, t0 + 1);
    const both = await repos.notifications.due(t0 + 1, 4, []);
    expect(both.map(laneOf)).toEqual([b, a]);
    const one = await repos.notifications.due(t0 + 1, 1, []);
    expect(one.map(laneOf)).toEqual([b]);
    const free = await repos.notifications.due(t0 + 1, 4, [b]);
    expect(free.map(laneOf)).toEqual([a]);
  });

  test("settling records a send, a retry with its failure and next time, and a failure for good", async () => {
    const repos = await repositories();
    const { a } = await twoChannels(repos);
    const [one, two, three] = await repos.notifications.enqueue(
      [a, a, a],
      "operator",
      down,
      t0
    );
    expect(
      await repos.notifications.settle(one?.id ?? "", {
        at: t0 + 10,
        attempts: 1,
        status: "sent",
      })
    ).toBe(true);
    await repos.notifications.settle(two?.id ?? "", {
      attempts: 2,
      failure: refused,
      nextAttemptAt: t0 + 150_000,
      status: "pending",
    });
    await repos.notifications.settle(three?.id ?? "", {
      at: t0 + 20,
      attempts: 4,
      failure: refused,
      status: "failed",
    });
    const byId = new Map(
      (await repos.notifications.recent(a, 10)).map((each) => [each.id, each])
    );
    expect(byId.get(one?.id ?? "")).toMatchObject({
      attempts: 1,
      failure: undefined,
      finishedAt: t0 + 10,
      nextAttemptAt: undefined,
      status: "sent",
    });
    expect(byId.get(two?.id ?? "")).toMatchObject({
      attempts: 2,
      failure: refused,
      finishedAt: undefined,
      nextAttemptAt: t0 + 150_000,
      status: "pending",
    });
    expect(byId.get(three?.id ?? "")).toMatchObject({
      attempts: 4,
      failure: refused,
      finishedAt: t0 + 20,
      nextAttemptAt: undefined,
      status: "failed",
    });
    expect(await repos.notifications.nextDueAt()).toBe(t0 + 150_000);
    expect(
      await repos.notifications.settle("gone", {
        at: t0,
        attempts: 1,
        status: "sent",
      })
    ).toBe(false);
  });

  test("the failure is stored as its reason code with its parameters and text", async () => {
    const repos = await repositories();
    const { a } = await twoChannels(repos);
    const [one] = await repos.notifications.enqueue([a], "operator", down, t0);
    await repos.notifications.settle(one?.id ?? "", {
      at: t0,
      attempts: 4,
      failure: refused,
      status: "failed",
    });
    const [row] = await runSql(
      repos.location,
      "SELECT reason, status, kind FROM notifications"
    );
    expect(row).toEqual({
      kind: "operator",
      reason: reasons.connection_refused,
      status: "failed",
    });
  });

  test("a finished test send is recorded without ever being pending", async () => {
    const repos = await repositories();
    const { a } = await twoChannels(repos);
    const recorded = await repos.notifications.record({
      channelId: a,
      kind: "test",
      payload: down,
      queuedAt: t0,
      settlement: { at: t0 + 80, attempts: 1, status: "sent" },
    });
    expect(recorded).toMatchObject({
      attempts: 1,
      finishedAt: t0 + 80,
      kind: "test",
      queuedAt: t0,
      status: "sent",
    });
    expect(await repos.notifications.nextDueAt()).toBeUndefined();
    expect(await repos.notifications.due(t0 + 1000, 4, [])).toEqual([]);
  });

  test("recent sends are newest first, and each channel's newest is its latest", async () => {
    const repos = await repositories();
    const { a, b } = await twoChannels(repos);
    await repos.notifications.enqueue([a], "operator", down, t0);
    const [newer] = await repos.notifications.enqueue(
      [a],
      "operator",
      down,
      t0 + 1
    );
    const [onlyB] = await repos.notifications.enqueue(
      [b],
      "operator",
      down,
      t0 + 2
    );
    const recent = await repos.notifications.recent(a, 10);
    expect(recent.map((each) => each.queuedAt)).toEqual([t0 + 1, t0]);
    expect(await repos.notifications.recent(a, 1)).toEqual([
      defined(recent[0]),
    ]);
    const latest = await repos.notifications.latest();
    expect(latest.get(a)?.id).toBe(newer?.id);
    expect(latest.get(b)?.id).toBe(onlyB?.id);
    expect(latest.size).toBe(2);
  });

  test("pruning keeps the newest finished notifications and every pending one", async () => {
    const repos = await repositories();
    const { a, b } = await twoChannels(repos);
    for (let n = 0; n < 5; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each send is recorded after the one before it
      await repos.notifications.record({
        channelId: a,
        kind: "test",
        payload: down,
        queuedAt: t0 + n,
        settlement: { at: t0 + n, attempts: 1, status: "sent" },
      });
    }
    await repos.notifications.enqueue([a], "operator", down, t0 - 1);
    await repos.notifications.record({
      channelId: b,
      kind: "test",
      payload: down,
      queuedAt: t0,
      settlement: { at: t0, attempts: 1, status: "sent" },
    });
    expect(await repos.notifications.prune(a, 2)).toBe(3);
    const left = await repos.notifications.recent(a, 10);
    expect(left.map((each) => [each.status, each.queuedAt])).toEqual([
      ["sent", t0 + 4],
      ["sent", t0 + 3],
      ["pending", t0 - 1],
    ]);
    expect(await repos.notifications.recent(b, 10)).toHaveLength(1);
  });

  test("a stored notification this version cannot read is named", async () => {
    const repos = await repositories();
    const { a } = await twoChannels(repos);
    const [one] = await repos.notifications.enqueue([a], "operator", down, t0);
    await runSql(repos.location, "UPDATE notifications SET payload = ?", [
      '{"type": "monitor.paused"}',
    ]);
    await expect(repos.notifications.recent(a, 10)).rejects.toBeInstanceOf(
      NotificationShapeError
    );
    await expect(repos.notifications.due(t0, 4, [])).rejects.toThrow(
      one?.id ?? ""
    );
  });
});

const confirmation: SubscriberPayload = {
  page: { id: "p1", name: "حالة المثال", url: "https://status.example.test" },
  timestamp: "2023-11-14T22:13:20.000Z",
  type: "subscription.confirmation",
};

/** Two confirmed subscriptions of one page, by id. */
async function twoSubscriptions(repos: {
  pages: PagesRepository;
  subscriptions: SubscriptionsRepository;
}) {
  const { id: pageId } = await repos.pages.create({
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: false,
    published: true,
    locale: "ar",
    slug: "main",
    title: { ar: "main" },
  });
  const request = (address: string) =>
    repos.subscriptions.request({
      address,
      channel: "email",
      credentials: undefined,
      locale: "ar",
      pageId,
      quietSince: t0 - 1,
      requestedAt: t0,
    });
  const x = defined(await request("x@example.test"));
  const y = defined(await request("y@example.test"));
  return { pageId, x: x.id, y: y.id };
}

describe("subscriber notifications in the queue's table", () => {
  test("queues one pending subscriber notification per subscription with its payload, due when asked", async () => {
    const repos = await repositories();
    const { x, y } = await twoSubscriptions(repos);
    const queued = await repos.notifications.enqueueSubscribers(
      [x, y],
      confirmation,
      t0
    );
    expect(queued.map(laneOf)).toEqual([x, y]);
    expect(queued[0]).toMatchObject({
      attempts: 0,
      kind: "subscriber",
      nextAttemptAt: t0,
      payload: confirmation,
      queuedAt: t0,
      status: "pending",
      subscriptionId: x,
    });
    expect(await repos.notifications.nextDueAt()).toBe(t0);
    const due = await repos.notifications.due(t0, 4, []);
    expect(due).toEqual(queued);
    expect(
      await repos.notifications.enqueueSubscribers([], confirmation, t0)
    ).toEqual([]);
  });

  test("a channel's due notification goes before subscriber ones due earlier, so the operator's alerts never wait behind subscribers", async () => {
    const repos = await repositories();
    const { x, y } = await twoSubscriptions(repos);
    const { a } = await twoChannels(repos);
    await repos.notifications.enqueueSubscribers([x, y], confirmation, t0);
    await repos.notifications.enqueue([a], "operator", down, t0 + 1);
    expect((await repos.notifications.due(t0 + 1, 1, [])).map(laneOf)).toEqual([
      a,
    ]);
  });

  test("a busy subscription is left out and another subscription is not", async () => {
    const repos = await repositories();
    const { x, y } = await twoSubscriptions(repos);
    await repos.notifications.enqueueSubscribers([x, y], confirmation, t0);
    expect((await repos.notifications.due(t0, 4, [x])).map(laneOf)).toEqual([
      y,
    ]);
  });

  test("a subscription is a lane of its own: its oldest pending notification goes first, and a busy one is left out beside the channels", async () => {
    const repos = await repositories();
    const { x, y } = await twoSubscriptions(repos);
    const { a } = await twoChannels(repos);
    const [first] = await repos.notifications.enqueueSubscribers(
      [x],
      confirmation,
      t0
    );
    await repos.notifications.enqueueSubscribers([x], confirmation, t0 + 1);
    await repos.notifications.enqueueSubscribers([y], confirmation, t0 + 2);
    await repos.notifications.enqueue([a], "operator", down, t0 + 3);
    await repos.notifications.settle(defined(first).id, {
      attempts: 1,
      failure: refused,
      nextAttemptAt: t0 + 30_000,
      status: "pending",
    });
    // The channel's goes first, whatever its time; x waits behind its own retry.
    expect((await repos.notifications.due(t0 + 10, 4, [])).map(laneOf)).toEqual(
      [a, y]
    );
    expect(
      (await repos.notifications.due(t0 + 10, 4, [y])).map(laneOf)
    ).toEqual([a]);
    expect(await repos.notifications.nextDueAt()).toBe(t0 + 2);
  });

  test("the channels' reads never see a subscriber notification", async () => {
    const repos = await repositories();
    const { x } = await twoSubscriptions(repos);
    const { a } = await twoChannels(repos);
    await repos.notifications.enqueueSubscribers([x], confirmation, t0);
    await repos.notifications.enqueue([a], "operator", down, t0 - 1);
    const latest = await repos.notifications.latest();
    expect([...latest.keys()]).toEqual([a]);
    expect(await repos.notifications.recent(a, 10)).toHaveLength(1);
  });

  test("each subscription's last finished send, and pruning to a subscription's newest finished ones", async () => {
    const repos = await repositories();
    const { x, y } = await twoSubscriptions(repos);
    const queued = await Promise.all(
      [0, 1, 2].map((n) =>
        repos.notifications.enqueueSubscribers([x], confirmation, t0 + n)
      )
    );
    for (const [n, [each]] of queued.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: each settles after the one before it
      await repos.notifications.settle(defined(each).id, {
        at: t0 + 10 + n,
        attempts: 1,
        status: "sent",
      });
    }
    await repos.notifications.enqueueSubscribers([x], confirmation, t0 + 5);
    await repos.notifications.enqueueSubscribers([y], confirmation, t0 + 6);
    const last = await repos.notifications.lastSends([x, y]);
    expect(last.get(x)).toMatchObject({ finishedAt: t0 + 12, status: "sent" });
    expect(last.has(y)).toBe(false);
    expect(await repos.notifications.prune(x, 1)).toBe(2);
    const left = await runSql(
      repos.location,
      "SELECT status, queued_at FROM notifications WHERE subscription_id = ? ORDER BY queued_at",
      [x]
    );
    expect(left.map((row) => [row.status, Number(row.queued_at)])).toEqual([
      ["sent", t0 + 2],
      ["pending", t0 + 5],
    ]);
  });

  test("a subscription's last send is its pending notification once an attempt has failed, and not before the first attempt", async () => {
    const repos = await repositories();
    const { x, y } = await twoSubscriptions(repos);
    const [tried] = await repos.notifications.enqueueSubscribers(
      [x],
      confirmation,
      t0
    );
    await repos.notifications.enqueueSubscribers([y], confirmation, t0);
    await repos.notifications.settle(tried?.id ?? "", {
      attempts: 1,
      failure: refused,
      nextAttemptAt: t0 + 30_000,
      status: "pending",
    });
    const last = await repos.notifications.lastSends([x, y]);
    expect(last.get(x)).toMatchObject({
      attempts: 1,
      failure: refused,
      status: "pending",
    });
    expect(last.has(y)).toBe(false);
  });

  test("a failing retry is a subscription's last send even after an older one was sent", async () => {
    const repos = await repositories();
    const { x } = await twoSubscriptions(repos);
    const [newer] = await repos.notifications.enqueueSubscribers(
      [x],
      confirmation,
      t0 + 1
    );
    const [older] = await repos.notifications.enqueueSubscribers(
      [x],
      confirmation,
      t0
    );
    await repos.notifications.settle(older?.id ?? "", {
      at: t0 + 2,
      attempts: 1,
      status: "sent",
    });
    await repos.notifications.settle(newer?.id ?? "", {
      attempts: 1,
      failure: refused,
      nextAttemptAt: t0 + 30_000,
      status: "pending",
    });
    const last = await repos.notifications.lastSends([x]);
    expect(last.get(x)).toMatchObject({ id: newer?.id, status: "pending" });
  });

  test("of two notifications queued at the same moment, the one with the greater id is a subscription's last send, whatever order the rows come back in", async () => {
    const repos = await repositories();
    const { x } = await twoSubscriptions(repos);
    const [retrying] = await repos.notifications.enqueueSubscribers(
      [x],
      confirmation,
      t0
    );
    const [sent] = await repos.notifications.enqueueSubscribers(
      [x],
      confirmation,
      t0
    );
    await repos.notifications.settle(retrying?.id ?? "", {
      attempts: 1,
      failure: refused,
      nextAttemptAt: t0 + 30_000,
      status: "pending",
    });
    await repos.notifications.settle(sent?.id ?? "", {
      at: t0 + 1,
      attempts: 1,
      status: "sent",
    });
    // The retrying row is stored first and has the greater id, so a read that ranks by storage order alone picks the sent one.
    await runSql(
      repos.location,
      "UPDATE notifications SET id = ? WHERE id = ?",
      ["zzz-retrying", retrying?.id ?? ""]
    );
    await runSql(
      repos.location,
      "UPDATE notifications SET id = ? WHERE id = ?",
      ["aaa-sent", sent?.id ?? ""]
    );
    const last = await repos.notifications.lastSends([x]);
    expect(last.get(x)).toMatchObject({
      id: "zzz-retrying",
      status: "pending",
    });
  });

  test("dropping deletes a notification that will never go", async () => {
    const repos = await repositories();
    const { x } = await twoSubscriptions(repos);
    const [one] = await repos.notifications.enqueueSubscribers(
      [x],
      confirmation,
      t0
    );
    await repos.notifications.drop(defined(one).id);
    expect(await repos.notifications.due(t0, 4, [])).toEqual([]);
    expect(await repos.notifications.nextDueAt()).toBeUndefined();
  });

  test("a subscription removed takes its notifications with it", async () => {
    const repos = await repositories();
    const { pageId, x } = await twoSubscriptions(repos);
    await repos.notifications.enqueueSubscribers([x], confirmation, t0);
    await repos.subscriptions.remove(pageId, x);
    expect(await repos.notifications.due(t0, 4, [])).toEqual([]);
  });

  test("the database refuses a notification for both a channel and a subscription, or for neither", async () => {
    const repos = await repositories();
    const { x } = await twoSubscriptions(repos);
    const { a } = await twoChannels(repos);
    const insert = (
      id: string,
      channel: string | null,
      subscription: string | null
    ) =>
      runSql(
        repos.location,
        `INSERT INTO notifications (id, channel_id, subscription_id, kind, payload, status, attempts, queued_at) VALUES (?, ${channel === null ? "NULL" : "?"}, ${subscription === null ? "NULL" : "?"}, 'operator', '{}', 'pending', 0, 0)`,
        [
          id,
          ...(channel === null ? [] : [channel]),
          ...(subscription === null ? [] : [subscription]),
        ]
      );
    await expect(insert("both", a, x)).rejects.toThrow();
    await expect(insert("neither", null, null)).rejects.toThrow();
  });

  test("a stored subscriber payload this version cannot read is named", async () => {
    const repos = await repositories();
    const { x } = await twoSubscriptions(repos);
    const [one] = await repos.notifications.enqueueSubscribers(
      [x],
      confirmation,
      t0
    );
    await runSql(repos.location, "UPDATE notifications SET payload = ?", [
      '{"type": "incident.deleted"}',
    ]);
    await expect(repos.notifications.due(t0, 4, [])).rejects.toThrow(
      defined(one).id
    );
  });
});

describe("many subscribers at once", () => {
  test("an event queued for six thousand subscriptions is written whole, in batches under both backends' limit of 65,535 parameters a statement, and read back", async () => {
    const repos = await repositories();
    const { pageId } = await twoSubscriptions(repos);
    const ids = Array.from({ length: 6000 }, (_, n) => `many-${n}`);
    await runSql(
      repos.location,
      `INSERT INTO subscriptions (id, page_id, channel, address, locale, token, status, requested_at, created_at) VALUES ${ids
        .map(
          (id) =>
            `('${id}', '${pageId}', 'email', '${id}@example.test', 'ar', '${id}', 'confirmed', 0, 0)`
        )
        .join(", ")}`
    );
    const queued = await repos.notifications.enqueueSubscribers(
      ids,
      confirmation,
      t0
    );
    expect(queued).toHaveLength(6000);
    const [count] = await runSql(
      repos.location,
      "SELECT COUNT(*) AS n FROM notifications WHERE subscription_id IS NOT NULL"
    );
    expect(Number(count?.n)).toBe(6000);
    await runSql(
      repos.location,
      "UPDATE notifications SET status = 'sent', finished_at = 1, next_attempt_at = NULL, attempts = 1"
    );
    expect((await repos.notifications.lastSends(ids)).size).toBe(6000);
  });
});
