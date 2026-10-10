import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { encrypt } from "@/server/boot/installkey.ts";
import { timeZone } from "@/server/settings/clock.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import type { SubscriberPayload } from "@/shared/schemas/subscription.ts";
import type { DeliverIo } from "./channel.ts";
import type { HostLookup } from "./destination.ts";
import { bodyText, fakeSmtp, parse } from "./fixture.ts";
import {
  createNotificationQueue,
  deliveriesInFlight,
  type NotificationQueue,
  nextAttemptAt,
  type QueueStorage,
  retryDelaysMs,
  sendsKept,
} from "./queue.ts";
import { newSigningSecret } from "./webhook.ts";

const key = await scratchInstallKey();
const t0 = 1_758_794_400_000;

let open:
  | {
      storage: Storage;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = {
    cleanup: scratch.cleanup,
    location: scratch.location,
    storage: opened.storage,
  };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

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
  timestamp: "2025-09-25T10:00:00.000Z",
  type: "monitor.down",
};

/** A webhook channel whose secrets are sealed as the channels module seals them. */
async function webhook(
  store: Storage,
  name: string,
  url: string
): Promise<string> {
  const sealed = await encrypt(
    key,
    JSON.stringify({ secret: newSigningSecret(), url })
  );
  const channel = await store.channels.create(
    {
      appliesToNew: false,
      config: {},
      locale: undefined,
      name,
      type: "webhook",
    },
    sealed
  );
  return channel.id;
}

type Answer = "ok" | "refuse" | "hold";

/**
 * A fetch that answers from a script, the clock it reads, and every request
 * it saw. "hold" keeps the request open until `release` is called;
 * `requested(n)` resolves once the nth request has arrived, held if it holds,
 * so a test waits for the drain rather than for a time.
 */
function network(script: (url: string, call: number) => Answer = () => "ok") {
  const seen: { body: string; headers: Headers; url: string }[] = [];
  const held: (() => void)[] = [];
  const arrivals = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const arrival = (call: number) => {
    const known = arrivals.get(call) ?? Promise.withResolvers<void>();
    arrivals.set(call, known);
    return known;
  };
  let now = t0;
  const fetchFake = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input);
    seen.push({
      body: String(init?.body ?? ""),
      headers: new Headers(init?.headers),
      url,
    });
    const call = seen.length;
    const answer = script(url, call);
    const released =
      answer === "hold"
        ? new Promise<void>((resolve) => held.push(resolve))
        : undefined;
    arrival(call).resolve();
    if (released !== undefined) {
      await released;
      return new Response(null, { status: 204 });
    }
    if (answer === "refuse") {
      throw Object.assign(new Error("Unable to connect"), {
        code: "ConnectionRefused",
      });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const io: DeliverIo = { fetch: fetchFake, now: () => now };
  return {
    io,
    release: () => {
      for (const resolve of held.splice(0)) {
        resolve();
      }
    },
    requested: (call: number) => arrival(call).promise,
    seen,
    set: (time: number) => {
      now = time;
    },
  };
}

function queueOver(
  store: QueueStorage,
  io: DeliverIo,
  stopped: { value: boolean } = { value: false }
): NotificationQueue {
  return createNotificationQueue(store, io, {
    installKey: key,
    isStopped: () => stopped.value,
  });
}

/** One turn of the event loop: every callback of a promise already settled has run. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** One tick at `time`, then everything it started settled. */
async function tickAt(
  queue: NotificationQueue,
  net: ReturnType<typeof network>,
  time: number
): Promise<void> {
  net.set(time);
  queue.run(time);
  await queue.idle();
}

describe("the backoff of the three retries", () => {
  test("a failed attempt is tried again 30 seconds, then 2 minutes, then 10 minutes later, and never after the third retry", () => {
    expect(retryDelaysMs).toEqual([30_000, 120_000, 600_000]);
    expect(nextAttemptAt(1, t0)).toBe(t0 + 30_000);
    expect(nextAttemptAt(2, t0)).toBe(t0 + 120_000);
    expect(nextAttemptAt(3, t0)).toBe(t0 + 600_000);
    expect(nextAttemptAt(4, t0)).toBeUndefined();
  });
});

describe("the queue's drain", () => {
  test("a queued notification is sent at the tick it is due and recorded as sent", async () => {
    const store = await storage();
    const net = network();
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const queue = queueOver(store, net.io);
    await queue.enqueue([channel], down, t0);
    await tickAt(queue, net, t0);
    expect(net.seen).toHaveLength(1);
    expect(net.seen[0]?.url).toBe("https://hooks.example.test/a");
    expect(JSON.parse(net.seen[0]?.body ?? "")).toEqual(down);
    const [sent] = await store.notifications.recent(channel, 10);
    expect(sent).toMatchObject({
      attempts: 1,
      finishedAt: t0,
      kind: "operator",
      status: "sent",
    });
    expect(net.seen[0]?.headers.get("webhook-id")).toBe(sent?.id ?? "");
  });

  test("a failed send retries three times with backoff, then fails for good with the last failure", async () => {
    const store = await storage();
    const net = network(() => "refuse");
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const queue = queueOver(store, net.io);
    await queue.enqueue([channel], down, t0);
    await tickAt(queue, net, t0);
    expect((await store.notifications.recent(channel, 1))[0]).toMatchObject({
      attempts: 1,
      nextAttemptAt: t0 + 30_000,
      status: "pending",
    });
    await tickAt(queue, net, t0 + 29_999);
    expect(net.seen).toHaveLength(1);
    await tickAt(queue, net, t0 + 30_000);
    await tickAt(queue, net, t0 + 30_000 + 120_000);
    await tickAt(queue, net, t0 + 30_000 + 120_000 + 600_000);
    expect(net.seen).toHaveLength(4);
    const [failed] = await store.notifications.recent(channel, 1);
    expect(failed).toMatchObject({
      attempts: 4,
      finishedAt: t0 + 750_000,
      nextAttemptAt: undefined,
      status: "failed",
    });
    expect(failed?.failure?.reason).toBe("connection_refused");
    await tickAt(queue, net, t0 + 10_000_000);
    expect(net.seen).toHaveLength(4);
  });

  test("a notification whose retry succeeds is sent, with the attempts it took", async () => {
    const store = await storage();
    const net = network((_url, call) => (call < 3 ? "refuse" : "ok"));
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const queue = queueOver(store, net.io);
    await queue.enqueue([channel], down, t0);
    await tickAt(queue, net, t0);
    await tickAt(queue, net, t0 + 30_000);
    await tickAt(queue, net, t0 + 150_000);
    expect((await store.notifications.recent(channel, 1))[0]).toMatchObject({
      attempts: 3,
      failure: undefined,
      status: "sent",
    });
  });

  test("every retry carries the same webhook-id", async () => {
    const store = await storage();
    const net = network((_url, call) => (call < 2 ? "refuse" : "ok"));
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const queue = queueOver(store, net.io);
    await queue.enqueue([channel], down, t0);
    await tickAt(queue, net, t0);
    await tickAt(queue, net, t0 + 30_000);
    const ids = net.seen.map((request) => request.headers.get("webhook-id"));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1] ?? "");
  });

  test("a channel's notifications arrive in the order they were queued, even while the first retries", async () => {
    const store = await storage();
    const net = network((_url, call) => (call === 1 ? "refuse" : "ok"));
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const queue = queueOver(store, net.io);
    const recovered: NotificationPayload = {
      data: { downtimeMs: 60_000, monitor: down.data.monitor },
      timestamp: "2025-09-25T10:01:00.000Z",
      type: "monitor.recovered",
    };
    await queue.enqueue([channel], down, t0);
    await queue.enqueue([channel], recovered, t0 + 1);
    await tickAt(queue, net, t0 + 1);
    await tickAt(queue, net, t0 + 10_000);
    expect(net.seen).toHaveLength(1);
    await tickAt(queue, net, t0 + 30_000);
    await tickAt(queue, net, t0 + 30_001);
    const types = net.seen.map(
      (request) => (JSON.parse(request.body) as NotificationPayload).type
    );
    expect(types).toEqual([
      "monitor.down",
      "monitor.down",
      "monitor.recovered",
    ]);
  });

  test("a notification on the network is never started again while it is out", async () => {
    const store = await storage();
    const net = network(() => "hold");
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const queue = queueOver(store, net.io);
    await queue.enqueue([channel], down, t0);
    net.set(t0);
    queue.run(t0);
    await net.requested(1);
    queue.run(t0 + 1000);
    // A real-time wait that asserts nothing starts again: a second start would arrive within it.
    await Bun.sleep(20);
    expect(net.seen).toHaveLength(1);
    net.release();
    await queue.idle();
  });

  test("at most four deliveries run at once, one per channel", async () => {
    expect(deliveriesInFlight).toBe(4);
    const store = await storage();
    // The first four are held; the three that follow answer at once, so one release lets the drain finish.
    const net = network((_url, call) =>
      call <= deliveriesInFlight ? "hold" : "ok"
    );
    const ids: string[] = [];
    for (let n = 0; n < deliveriesInFlight + 2; n += 1) {
      ids.push(
        // biome-ignore lint/performance/noAwaitInLoops: the channels are created in order
        await webhook(store, `c${n}`, `https://hooks.example.test/${n}`)
      );
    }
    const queue = queueOver(store, net.io);
    await queue.enqueue(ids, down, t0);
    await queue.enqueue([ids[0] ?? ""], down, t0);
    net.set(t0);
    queue.run(t0);
    await net.requested(deliveriesInFlight);
    queue.run(t0);
    // A real-time wait that asserts nothing more starts: a fifth start would arrive within it.
    await Bun.sleep(20);
    expect(net.seen).toHaveLength(deliveriesInFlight);
    expect(new Set(net.seen.map((request) => request.url)).size).toBe(
      deliveriesInFlight
    );
    // Each settled delivery lets the drain start the next due one at once, with no tick.
    net.release();
    await queue.idle();
    expect(net.seen).toHaveLength(deliveriesInFlight + 3);
  });

  test("an empty queue costs no query on a tick, and enqueue makes the drain look again", async () => {
    const store = await storage();
    const net = network();
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    let reads = 0;
    const counted: QueueStorage = {
      ...store,
      notifications: {
        ...store.notifications,
        due: (...args) => {
          reads += 1;
          return store.notifications.due(...args);
        },
        nextDueAt: () => {
          reads += 1;
          return store.notifications.nextDueAt();
        },
      },
    };
    const queue = queueOver(counted, net.io);
    await tickAt(queue, net, t0);
    const afterBoot = reads;
    for (let n = 1; n <= 5; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one tick after another
      await tickAt(queue, net, t0 + n * 1000);
    }
    expect(reads).toBe(afterBoot);
    await queue.enqueue([channel], down, t0 + 6000);
    await tickAt(queue, net, t0 + 6000);
    expect(net.seen).toHaveLength(1);
  });

  test("a notification queued before the drain started is found at its first run", async () => {
    const store = await storage();
    const net = network();
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    await store.notifications.enqueue([channel], "operator", down, t0 - 60_000);
    const queue = queueOver(store, net.io);
    await tickAt(queue, net, t0);
    await tickAt(queue, net, t0 + 1000);
    expect(net.seen).toHaveLength(1);
  });

  test("an attempt that ends after the scheduler stopped is not settled and starts again at the next boot", async () => {
    const store = await storage();
    const net = network(() => "hold");
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const stopped = { value: false };
    const queue = queueOver(store, net.io, stopped);
    await queue.enqueue([channel], down, t0);
    queue.run(t0);
    await net.requested(1);
    stopped.value = true;
    net.release();
    await queue.idle();
    await queue.flush();
    expect((await store.notifications.recent(channel, 1))[0]).toMatchObject({
      attempts: 0,
      status: "pending",
    });
    const next = network();
    const booted = queueOver(store, next.io);
    await tickAt(booted, next, t0 + 1000);
    expect(next.seen).toHaveLength(1);
    expect(next.seen[0]?.headers.get("webhook-id")).toBe(
      net.seen[0]?.headers.get("webhook-id") ?? ""
    );
  });

  test("a channel whose secrets the install key cannot open fails its attempt and retries like any other", async () => {
    const store = await storage();
    const net = network();
    const channel = await store.channels.create(
      {
        appliesToNew: false,
        config: {},
        locale: undefined,
        name: "x",
        type: "webhook",
      },
      await encrypt(await scratchInstallKey(), "{}")
    );
    const queue = queueOver(store, net.io);
    await queue.enqueue([channel.id], down, t0);
    await tickAt(queue, net, t0);
    expect(net.seen).toHaveLength(0);
    const [waiting] = await store.notifications.recent(channel.id, 1);
    expect(waiting).toMatchObject({
      attempts: 1,
      nextAttemptAt: t0 + 30_000,
      status: "pending",
    });
    expect(waiting?.failure?.error).toContain("install key");
  });

  test("a channel deleted while its notification is on the network leaves nothing behind and no error", async () => {
    const store = await storage();
    const net = network(() => "hold");
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const queue = queueOver(store, net.io);
    await queue.enqueue([channel], down, t0);
    queue.run(t0);
    await net.requested(1);
    await store.channels.remove(channel);
    const lines: string[] = [];
    const errors = spyOn(process.stderr, "write").mockImplementation((text) => {
      lines.push(String(text));
      return true;
    });
    try {
      net.release();
      await queue.idle();
    } finally {
      errors.mockRestore();
    }
    expect(await store.notifications.recent(channel, 10)).toEqual([]);
    // The "no error" half of the name, pinned.
    expect(lines).toEqual([]);
  });

  test("each channel keeps its newest fifty finished sends", async () => {
    const store = await storage();
    const net = network();
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const queue = queueOver(store, net.io);
    for (let n = 0; n < sendsKept + 2; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: queued in order so the oldest are the ones pruned
      await queue.enqueue([channel], down, t0 + n);
    }
    for (let round = 0; round < sendsKept + 2; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one send a round, in order
      await tickAt(queue, net, t0 + sendsKept + 2);
    }
    const kept = await store.notifications.recent(channel, 100);
    expect(kept).toHaveLength(sendsKept);
    expect(kept.at(-1)?.queuedAt).toBe(t0 + 2);
  });
});

describe("the queue's drain when storage fails", () => {
  test("a read that fails is tried again a minute later, not on every tick", async () => {
    const store = await storage();
    const net = network();
    let reads = 0;
    const failing: QueueStorage = {
      ...store,
      notifications: {
        ...store.notifications,
        nextDueAt: () => {
          reads += 1;
          return Promise.reject(new Error("database gone"));
        },
      },
    };
    const queue = queueOver(failing, net.io);
    await tickAt(queue, net, t0);
    await tickAt(queue, net, t0 + 1000);
    await tickAt(queue, net, t0 + 59_999);
    expect(reads).toBe(1);
    await tickAt(queue, net, t0 + 60_000);
    expect(reads).toBe(2);
  });
});

describe("the queue's drain while deliveries settle during a read", () => {
  test("a retry that settles while the drain reads is still tried at its time", async () => {
    const store = await storage();
    const net = network((url) => (url.endsWith("/a") ? "hold" : "refuse"));
    const held = await webhook(store, "a", "https://hooks.example.test/a");
    const refusing = await webhook(store, "b", "https://hooks.example.test/b");
    let reads = 0;
    const reading = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const pruned = Promise.withResolvers<void>();
    const gated: QueueStorage = {
      ...store,
      notifications: {
        ...store.notifications,
        nextDueAt: async () => {
          reads += 1;
          const answer = await store.notifications.nextDueAt();
          // The second read answers what it saw only after the held delivery settled.
          if (reads === 2) {
            reading.resolve();
            await gate.promise;
          }
          return answer;
        },
        // Only the held delivery is sent, so the one prune is the end of its settlement.
        prune: async (...args) => {
          const removed = await store.notifications.prune(...args);
          pruned.resolve();
          return removed;
        },
      },
    };
    const queue = queueOver(gated, net.io);
    await queue.enqueue([held, refusing], down, t0);
    net.set(t0);
    queue.run(t0);
    await Promise.all([reading.promise, net.requested(2)]);
    expect(reads).toBe(2);
    net.release();
    await pruned.promise;
    await nextTurn();
    gate.resolve();
    await queue.idle();
    const refused = () =>
      net.seen.filter((request) => request.url.endsWith("/b")).length;
    expect(refused()).toBe(1);
    await tickAt(queue, net, t0 + 30_000);
    expect(refused()).toBe(2);
  });
});

describe("the queue's drain while a notification is queued during a read", () => {
  test("a notification queued while the drain reads the queue is still sent", async () => {
    const store = await storage();
    const net = network();
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const reading = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let reads = 0;
    const gated: QueueStorage = {
      ...store,
      notifications: {
        ...store.notifications,
        nextDueAt: async () => {
          reads += 1;
          const answer = await store.notifications.nextDueAt();
          // The first read answers what it saw only after the enqueue.
          if (reads === 1) {
            reading.resolve();
            await gate.promise;
          }
          return answer;
        },
      },
    };
    const queue = queueOver(gated, net.io);
    net.set(t0);
    queue.run(t0);
    await reading.promise;
    await queue.enqueue([channel], down, t0);
    gate.resolve();
    await queue.idle();
    await tickAt(queue, net, t0 + 1000);
    expect(net.seen).toHaveLength(1);
  });
});

describe("the queue's drain while a channel is deleted during a read", () => {
  test("another channel's later retry is still tried when the due one's channel went during the read", async () => {
    const store = await storage();
    const net = network(() => "refuse");
    const later = await webhook(store, "later", "https://hooks.example.test/b");
    const plain = createNotificationQueue(store, net.io, {
      installKey: key,
      isStopped: () => false,
    });
    await plain.enqueue([later], down, t0);
    await tickAt(plain, net, t0);
    expect(net.seen).toHaveLength(1);
    const gone = await webhook(store, "gone", "https://hooks.example.test/a");
    await store.notifications.enqueue([gone], "operator", down, t0 + 1000);
    const reading = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let reads = 0;
    let dueReads = 0;
    const gated: QueueStorage = {
      ...store,
      notifications: {
        ...store.notifications,
        due: (...args) => {
          dueReads += 1;
          return store.notifications.due(...args);
        },
        nextDueAt: async () => {
          reads += 1;
          const answer = await store.notifications.nextDueAt();
          // The first read answers what it saw only after the channel went; the reads after it answer at once.
          if (reads === 1) {
            reading.resolve();
            await gate.promise;
          }
          return answer;
        },
      },
    };
    const queue = queueOver(gated, net.io);
    net.set(t0 + 1000);
    queue.run(t0 + 1000);
    await reading.promise;
    await store.channels.remove(gone);
    gate.resolve();
    await queue.idle();
    const before = dueReads;
    // The next tick reads the next due time again, and then nothing is due before the retry.
    for (let n = 2; n <= 6; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one tick after another
      await tickAt(queue, net, t0 + n * 1000);
    }
    expect(dueReads).toBe(before);
    await tickAt(queue, net, t0 + 30_000);
    expect(net.seen).toHaveLength(2);
  });
});

describe("a failure the reason dictionary cannot hold", () => {
  test("is recorded as unknown, so the channel's recent sends stay readable", async () => {
    const store = await storage();
    const net = network(() => "refuse");
    // Port 0 is outside what the connection_refused reason may name.
    const channel = await webhook(store, "zero", "http://127.0.0.1:0/hook");
    const queue = queueOver(store, net.io);
    await queue.enqueue([channel], down, t0);
    await tickAt(queue, net, t0);
    const [waiting] = await store.notifications.recent(channel, 1);
    expect(waiting?.status).toBe("pending");
    expect(waiting?.failure?.reason).toBe("unknown");
  });
});

describe("the queue after the scheduler stops", () => {
  test("a settlement under way at stop is the last write: no prune follows it", async () => {
    const store = await storage();
    const net = network();
    const channel = await webhook(store, "ops", "https://hooks.example.test/a");
    const stopped = { value: false };
    const settling = Promise.withResolvers<void>();
    const releaseSettle = Promise.withResolvers<void>();
    let pruned = 0;
    const slow: QueueStorage = {
      ...store,
      notifications: {
        ...store.notifications,
        prune: (...args) => {
          pruned += 1;
          return store.notifications.prune(...args);
        },
        settle: async (...args) => {
          // The settlement is on its way when the scheduler stops.
          settling.resolve();
          await releaseSettle.promise;
          return store.notifications.settle(...args);
        },
      },
    };
    const queue = queueOver(slow, net.io, stopped);
    await queue.enqueue([channel], down, t0);
    queue.run(t0);
    await settling.promise;
    stopped.value = true;
    const flushed = queue.flush();
    releaseSettle.resolve();
    await flushed;
    await queue.idle();
    expect(pruned).toBe(0);
    expect((await store.notifications.recent(channel, 1))[0]?.status).toBe(
      "sent"
    );
  });
});

describe("a queued email", () => {
  test("is written in the channel language with the install time zone", async () => {
    const store = await storage();
    await store.settings.set(timeZone, "Asia/Riyadh");
    const server = fakeSmtp();
    try {
      const channel = await store.channels.create(
        {
          appliesToNew: false,
          config: {
            from: "alerts@example.test",
            host: "127.0.0.1",
            port: String(server.port),
            security: "none",
            to: "ops@example.test",
          },
          locale: "en",
          name: "Ops mail",
          type: "email",
        },
        undefined
      );
      const queue = createNotificationQueue(
        store,
        { fetch, now: Date.now },
        { installKey: key, isStopped: () => false }
      );
      await queue.enqueue([channel.id], down, Date.now());
      queue.run(Date.now());
      await queue.idle();
      const text = bodyText(parse(server.messages[0] ?? ""));
      expect(text).toContain("The monitor is down.");
      expect(text).toContain("(GMT+3)");
    } finally {
      server.stop();
    }
  });
});

describe("the queue's drain delivers subscriber notifications", () => {
  const confirmation = (pageId: string): SubscriberPayload => ({
    page: { id: pageId, name: "main", url: "https://status.example.test" },
    timestamp: new Date(t0).toISOString(),
    type: "subscription.confirmation",
  });

  /** A page with one pending webhook subscription at the URL, sealed as the module seals it. */
  async function pendingHook(store: Storage, url: string) {
    const page = await store.pages.create({
      customDomain: undefined,
      customization: defaultCustomization,
      isDefault: false,
      published: true,
      locale: "ar",
      slug: "main",
      title: { ar: "main" },
    });
    const subscription = await store.subscriptions.request({
      address: "hash",
      channel: "webhook",
      credentials: await encrypt(key, url),
      locale: "ar",
      pageId: page.id,
      quietSince: t0 - 1,
      requestedAt: t0,
    });
    if (!subscription) {
      throw new Error("expected a subscription");
    }
    return { pageId: page.id, subscription };
  }

  const internet: HostLookup = () => Promise.resolve(["93.184.216.34"]);

  test("a subscriber notification goes out at the tick it is due to the subscriber's webhook, and is recorded as sent", async () => {
    const store = await storage();
    const net = network();
    const { pageId, subscription } = await pendingHook(
      store,
      "https://hooks.example.com/a"
    );
    const queue = queueOver(store, { ...net.io, lookup: internet });
    await queue.enqueueSubscribers([subscription.id], confirmation(pageId), t0);
    await tickAt(queue, net, t0);
    expect(net.seen.map((each) => each.url)).toEqual([
      "https://hooks.example.com/a",
    ]);
    const last = await store.notifications.lastSends([subscription.id]);
    expect(last.get(subscription.id)).toMatchObject({
      attempts: 1,
      finishedAt: t0,
      kind: "subscriber",
      status: "sent",
    });
  });

  test("queuing one lowers the next due time, so a drain that knew the queue empty sends it without waiting", async () => {
    const store = await storage();
    const net = network();
    const { pageId, subscription } = await pendingHook(
      store,
      "https://hooks.example.com/a"
    );
    const queue = queueOver(store, { ...net.io, lookup: internet });
    await tickAt(queue, net, t0);
    await queue.enqueueSubscribers([subscription.id], confirmation(pageId), t0);
    await tickAt(queue, net, t0);
    expect(net.seen).toHaveLength(1);
  });

  test("one its subscription no longer takes is dropped: nothing is sent and no row is left", async () => {
    const store = await storage();
    const net = network();
    const { pageId, subscription } = await pendingHook(
      store,
      "https://hooks.example.com/a"
    );
    await store.subscriptions.confirm(subscription.token, t0, t0 - 1);
    const queue = queueOver(store, { ...net.io, lookup: internet });
    await queue.enqueueSubscribers([subscription.id], confirmation(pageId), t0);
    await tickAt(queue, net, t0);
    expect(net.seen).toEqual([]);
    expect(await store.notifications.nextDueAt()).toBeUndefined();
    expect((await store.notifications.lastSends([subscription.id])).size).toBe(
      0
    );
  });

  test("a failed subscriber send is tried again on the same backoff", async () => {
    const store = await storage();
    const net = network(() => "refuse");
    const { pageId, subscription } = await pendingHook(
      store,
      "https://hooks.example.com/a"
    );
    const queue = queueOver(store, { ...net.io, lookup: internet });
    await queue.enqueueSubscribers([subscription.id], confirmation(pageId), t0);
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await tickAt(queue, net, t0);
    } finally {
      quiet.mockRestore();
    }
    expect(await store.notifications.nextDueAt()).toBe(t0 + 30_000);
  });

  test("a subscription keeps its two newest finished notifications and never prunes a pending one", async () => {
    const store = await storage();
    const net = network();
    const { pageId, subscription } = await pendingHook(
      store,
      "https://hooks.example.com/a"
    );
    const queue = queueOver(store, { ...net.io, lookup: internet });
    // Newer than every send below and not yet due, so it stays pending through each prune.
    await queue.enqueueSubscribers(
      [subscription.id],
      confirmation(pageId),
      t0 + 1000
    );
    for (let n = 0; n < 5; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each is sent before the next is queued
      await queue.enqueueSubscribers(
        [subscription.id],
        confirmation(pageId),
        t0 + n
      );
      await tickAt(queue, net, t0 + n);
    }
    expect(net.seen).toHaveLength(5);
    const rows = await runSql(
      open?.location ?? { backend: "sqlite", file: "" },
      "SELECT status, queued_at FROM notifications WHERE subscription_id = ? ORDER BY queued_at",
      [subscription.id]
    );
    // Postgres answers a bigint as text.
    expect(
      rows.map((row) => ({
        queuedAt: Number(row.queued_at),
        status: row.status,
      }))
    ).toEqual([
      { queuedAt: t0 + 3, status: "sent" },
      { queuedAt: t0 + 4, status: "sent" },
      { queuedAt: t0 + 1000, status: "pending" },
    ]);
  });
});
