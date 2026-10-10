import { describe, expect, spyOn, test } from "bun:test";
import type { MonitorEvent } from "@/server/scheduler/schedule.ts";
import { type Monitor, monitorEventKinds } from "@/shared/schemas/monitor.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  createOperatorNotifications,
  nextReminderAt,
  notificationOf,
  reminderOf,
} from "./operator.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const t0 = Date.parse("2026-09-26T09:00:00.000Z");
const address = { publicAddress: "https://status.example.test" };

function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    channels: ["c1", "c2"],
    config: {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      captureMode: "off",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      tlsExpiryDays: 14,
      type: "http",
      url: "https://api.example.test/health",
    },
    createdAt: t0 - day,
    degradedMs: 800,
    description: undefined,
    events: [...monitorEventKinds],
    group: undefined,
    id: "0199",
    intervalMs: minute,
    name: "API",
    paused: false,
    reminderMs: undefined,
    retentionDays: undefined,
    retries: 2,
    tags: [],
    target: "https://api.example.test/health",
    timeoutMs: 10_000,
    updatedAt: t0 - day,
    ...overrides,
  };
}

const opened: Outage = {
  endedAt: undefined,
  monitorId: "0199",
  reason: reasons.timeout,
  startedAt: t0,
};

const down: MonitorEvent = {
  at: t0,
  kind: "down",
  monitorId: "0199",
  outage: opened,
  reason: reasons.timeout,
};

const recovered: MonitorEvent = {
  at: t0 + 90 * minute,
  kind: "recovered",
  monitorId: "0199",
  outage: { ...opened, endedAt: t0 + 90 * minute },
  reason: reasons.ok,
};

const sampleMonitorData = {
  adminUrl: "https://status.example.test/admin/monitors/0199",
  checkType: "http" as const,
  id: "0199",
  name: "API",
  target: "https://api.example.test/health",
};

describe("what a monitor event sends", () => {
  test("down sends the reason, the monitor with its admin link, and the prefilled open-incident link", () => {
    expect(notificationOf(down, monitor(), address)).toEqual({
      data: {
        incidentUrl:
          "https://status.example.test/admin/incidents/new?monitor=0199",
        monitor: sampleMonitorData,
        reason: "timeout",
      },
      timestamp: "2026-09-26T09:00:00.000Z",
      type: "monitor.down",
    });
  });

  test("recovered sends the downtime of the outage it closed", () => {
    expect(notificationOf(recovered, monitor(), address)).toEqual({
      data: { downtimeMs: 90 * minute, monitor: sampleMonitorData },
      timestamp: "2026-09-26T10:30:00.000Z",
      type: "monitor.recovered",
    });
  });

  test("down and recovered follow the outage record: with no outage opened or closed they send nothing", () => {
    expect(
      notificationOf({ ...down, outage: undefined }, monitor(), address)
    ).toBeUndefined();
    expect(
      notificationOf({ ...recovered, outage: undefined }, monitor(), address)
    ).toBeUndefined();
  });

  test("the degraded pair sends the reason when it starts and nothing more when it ends", () => {
    expect(
      notificationOf(
        {
          at: t0,
          kind: "degraded_started",
          monitorId: "0199",
          reason: reasons.slow,
        },
        monitor(),
        address
      )
    ).toEqual({
      data: { monitor: sampleMonitorData, reason: "slow" },
      timestamp: "2026-09-26T09:00:00.000Z",
      type: "monitor.degraded_started",
    });
    expect(
      notificationOf(
        {
          at: t0,
          kind: "degraded_ended",
          monitorId: "0199",
          reason: reasons.ok,
        },
        monitor(),
        address
      )
    ).toEqual({
      data: { monitor: sampleMonitorData },
      timestamp: "2026-09-26T09:00:00.000Z",
      type: "monitor.degraded_ended",
    });
  });

  test("certificate expiring sends the whole days left, rounded down, and when it expires", () => {
    const validTo = t0 + 13 * day + 5 * hour;
    expect(
      notificationOf(
        {
          at: t0,
          kind: "certificate_expiring",
          monitorId: "0199",
          validTo,
          warning: "threshold",
        },
        monitor(),
        address
      )
    ).toEqual({
      data: {
        certificate: {
          daysLeft: 13,
          notAfter: "2026-10-09T14:00:00.000Z",
        },
        monitor: sampleMonitorData,
      },
      timestamp: "2026-09-26T09:00:00.000Z",
      type: "monitor.certificate_expiring",
    });
  });

  test("an event the monitor switched off sends nothing", () => {
    expect(
      notificationOf(down, monitor({ events: ["recovered"] }), address)
    ).toBeUndefined();
    expect(
      notificationOf(recovered, monitor({ events: ["down"] }), address)
    ).toBeUndefined();
  });

  test("an event that cannot happen for the monitor sends nothing: degraded without a threshold", () => {
    expect(
      notificationOf(
        {
          at: t0,
          kind: "degraded_ended",
          monitorId: "0199",
          reason: reasons.ok,
        },
        monitor({ degradedMs: undefined }),
        address
      )
    ).toBeUndefined();
  });

  test("with no public address stored, the notification carries no links", () => {
    const sent = notificationOf(down, monitor(), { publicAddress: undefined });
    expect(sent?.type).toBe("monitor.down");
    expect(sent && "monitor" in sent.data && sent.data.monitor).toEqual({
      checkType: "http",
      id: "0199",
      name: "API",
      target: "https://api.example.test/health",
    });
    expect(sent && "incidentUrl" in sent.data).toBe(false);
  });

  test("a heartbeat monitor is sent with no target", () => {
    const beat = monitor({
      config: {
        schedule: { everyMs: hour, kind: "every" },
        type: "heartbeat",
      },
      degradedMs: undefined,
      target: undefined,
    });
    const sent = notificationOf(
      { ...down, reason: reasons.heartbeat_late },
      beat,
      address
    );
    expect(sent).toMatchObject({
      data: { monitor: { checkType: "heartbeat", target: null } },
    });
  });
});

describe('a reminder (CONTEXT.md "Reminder")', () => {
  test("says the monitor is still down, why the outage opened, and for how long", () => {
    expect(reminderOf(monitor(), opened, address, t0 + 2 * hour)).toEqual({
      data: {
        downForMs: 2 * hour,
        monitor: sampleMonitorData,
        reason: "timeout",
      },
      timestamp: "2026-09-26T11:00:00.000Z",
      type: "monitor.reminder",
    });
  });

  test("falls at the outage's start plus whole multiples of the interval, the first after the last send", () => {
    expect(nextReminderAt(t0, hour, t0)).toBe(t0 + hour);
    expect(nextReminderAt(t0, hour, t0 + hour)).toBe(t0 + 2 * hour);
    expect(nextReminderAt(t0, hour, t0 + hour + 1)).toBe(t0 + 2 * hour);
    expect(nextReminderAt(t0, hour, t0 + 5 * hour - 1)).toBe(t0 + 5 * hour);
  });

  test("an interval changed while down counts from the outage's start with the new interval", () => {
    expect(nextReminderAt(t0, 15 * minute, t0 + hour)).toBe(
      t0 + hour + 15 * minute
    );
  });
});

/** A queue that records what it is asked to queue, and outages the test lists. */
function world(ongoing: Outage[] = [], covered: Set<string> = new Set()) {
  const queued: {
    channelIds: readonly string[];
    payload: NotificationPayload;
    now: number;
  }[] = [];
  const outageReads = { count: 0 };
  let failQueue = false;
  /** What a test runs inside the open outages' read or a queue write, to land something while either is under way. */
  const hooks: {
    duringEnqueue?: (payload: NotificationPayload) => void;
    duringOngoing?: () => Promise<void>;
  } = {};
  const notifications = createOperatorNotifications(
    {
      outages: {
        acknowledge: () => Promise.resolve(undefined),
        close: () => Promise.resolve(undefined),
        list: () => Promise.resolve([]),
        since: () => Promise.resolve(new Map()),
        ongoing: async () => {
          outageReads.count += 1;
          await hooks.duringOngoing?.();
          return ongoing;
        },
        open: () => Promise.resolve(false),
      },
    },
    {
      enqueue: (channelIds, payload, now) => {
        if (failQueue) {
          return Promise.reject(new Error("the database did not answer"));
        }
        queued.push({ channelIds, now, payload });
        hooks.duringEnqueue?.(payload);
        return Promise.resolve();
      },
    },
    {
      context: () => address,
      covers: (id) => covered.has(id),
      isStopped: () => false,
    }
  );
  return {
    failQueue: () => {
      failQueue = true;
    },
    hooks,
    notifications,
    queueWorks: () => {
      failQueue = false;
    },
    outageReads,
    queued,
    types: () => queued.map((each) => each.payload.type),
  };
}

const allDown = () => true;

async function remindAt(
  w: ReturnType<typeof world>,
  now: number,
  monitors: readonly Monitor[],
  isDown: (id: string) => boolean = allDown
) {
  w.notifications.remind(now, monitors, isDown);
  await w.notifications.idle();
}

describe("the operator notifications a monitor event queues", () => {
  test("an event queues its notification once for each of the monitor's channels", async () => {
    const w = world();
    await w.notifications.raise(down, monitor(), t0 + 5);
    expect(w.queued).toEqual([
      {
        channelIds: ["c1", "c2"],
        now: t0 + 5,
        payload: notificationOf(
          down,
          monitor(),
          address
        ) as NotificationPayload,
      },
    ]);
  });

  test("a monitor with no channel, or an event it does not send, queues nothing", async () => {
    const w = world();
    await w.notifications.raise(down, monitor({ channels: [] }), t0);
    await w.notifications.raise(down, monitor({ events: [] }), t0);
    expect(w.queued).toEqual([]);
  });

  test("a queue that fails is logged and never throws", async () => {
    const w = world();
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      w.failQueue();
      await w.notifications.raise(down, monitor(), t0);
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("0199");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("the reminders while a monitor stays down", () => {
  const reminding = monitor({ reminderMs: hour });

  test("repeat at the interval after the down notification, and not between", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    await remindAt(w, t0 + hour - 1, [reminding]);
    expect(w.types()).toEqual(["monitor.down"]);
    await remindAt(w, t0 + hour, [reminding]);
    await remindAt(w, t0 + hour + 30 * minute, [reminding]);
    expect(w.types()).toEqual(["monitor.down", "monitor.reminder"]);
    await remindAt(w, t0 + 2 * hour + 1, [reminding]);
    expect(w.types()).toEqual([
      "monitor.down",
      "monitor.reminder",
      "monitor.reminder",
    ]);
    expect(w.queued[2]?.payload).toEqual(
      reminderOf(reminding, opened, address, t0 + 2 * hour + 1)
    );
    expect(w.queued[2]?.channelIds).toEqual(["c1", "c2"]);
  });

  test("are off by default", async () => {
    const w = world();
    await remindAt(w, t0, [monitor()]);
    await w.notifications.raise(down, monitor(), t0);
    await remindAt(w, t0 + day, [monitor()]);
    expect(w.types()).toEqual(["monitor.down"]);
  });

  test("stop once the monitor recovers", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    await w.notifications.raise(recovered, reminding, t0 + 30 * minute);
    await remindAt(w, t0 + 3 * hour, [reminding]);
    expect(w.types()).toEqual(["monitor.down", "monitor.recovered"]);
  });

  test("stop for a monitor that is paused, deleted, or no longer down", async () => {
    for (const [monitors, isDown] of [
      [[{ ...reminding, paused: true }], allDown],
      [[], allDown],
      [[reminding], () => false],
    ] as const) {
      const w = world();
      // biome-ignore lint/performance/noAwaitInLoops: each case runs on its own world, one after the other
      await remindAt(w, t0, [reminding]);
      await w.notifications.raise(down, reminding, t0);
      await remindAt(w, t0 + 3 * hour, monitors, isDown);
      expect(w.types()).toEqual(["monitor.down"]);
    }
  });

  test("repeat only while the down event is on, since a reminder repeats it", async () => {
    const w = world();
    const quiet = { ...reminding, events: ["recovered" as const] };
    await remindAt(w, t0, [quiet]);
    await w.notifications.raise(down, quiet, t0);
    await remindAt(w, t0 + 3 * hour, [quiet]);
    expect(w.queued).toEqual([]);
  });

  test("after a restart, an outage still open reminds at its next multiple; the ones missed while stopped are not sent", async () => {
    const w = world([opened]);
    const boot = t0 + 5 * hour + 10 * minute;
    await remindAt(w, boot, [reminding]);
    expect(w.queued).toEqual([]);
    await remindAt(w, t0 + 6 * hour, [reminding]);
    expect(w.types()).toEqual(["monitor.reminder"]);
    expect(w.queued[0]?.payload).toMatchObject({
      data: { downForMs: 6 * hour },
    });
  });

  test("read the open outages once, at the first pass", async () => {
    const w = world([opened]);
    await remindAt(w, t0, [reminding]);
    await remindAt(w, t0 + minute, [reminding]);
    await remindAt(w, t0 + 2 * minute, [reminding]);
    expect(w.outageReads.count).toBe(1);
  });
});

describe("edges of the reminders", () => {
  const reminding = monitor({ reminderMs: hour });

  test("a recovery with no outage to close (a pause closed it) still ends the reminders", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    await w.notifications.raise(
      { ...recovered, outage: undefined },
      reminding,
      t0 + minute
    );
    await remindAt(w, t0 + 3 * hour, [reminding]);
    expect(w.types()).toEqual(["monitor.down"]);
  });

  test("a monitor down with no channel queues no reminder, and the reminders of the others go on", async () => {
    const w = world([opened, { ...opened, monitorId: "0200" }]);
    const lonely = { ...reminding, channels: [] };
    const other = { ...reminding, id: "0200" };
    await remindAt(w, t0, [lonely, other]);
    await remindAt(w, t0 + hour, [lonely, other]);
    expect(w.queued.map((each) => each.payload)).toEqual([
      reminderOf(other, { ...opened, monitorId: "0200" }, address, t0 + hour),
    ]);
  });

  test("once the scheduler stops, no reminder pass starts", async () => {
    let stopped = false;
    const queued: NotificationPayload[] = [];
    const notifications = createOperatorNotifications(
      {
        outages: {
          acknowledge: () => Promise.resolve(undefined),
          close: () => Promise.resolve(undefined),
          list: () => Promise.resolve([]),
          since: () => Promise.resolve(new Map()),
          ongoing: () => Promise.resolve([opened]),
          open: () => Promise.resolve(false),
        },
      },
      {
        enqueue: (_ids, payload) => {
          queued.push(payload);
          return Promise.resolve();
        },
      },
      { context: () => address, isStopped: () => stopped }
    );
    notifications.remind(t0, [reminding], allDown);
    await notifications.idle();
    stopped = true;
    notifications.remind(t0 + 3 * hour, [reminding], allDown);
    await notifications.idle();
    expect(queued).toEqual([]);
  });

  test("an outage read that fails is tried again at the next pass", async () => {
    let reads = 0;
    const notifications = createOperatorNotifications(
      {
        outages: {
          acknowledge: () => Promise.resolve(undefined),
          close: () => Promise.resolve(undefined),
          list: () => Promise.resolve([]),
          since: () => Promise.resolve(new Map()),
          ongoing: () => {
            reads += 1;
            return reads === 1
              ? Promise.reject(new Error("the database did not answer"))
              : Promise.resolve([]);
          },
          open: () => Promise.resolve(false),
        },
      },
      { enqueue: () => Promise.resolve() },
      { context: () => address, isStopped: () => false }
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      notifications.remind(t0, [], allDown);
      await notifications.idle();
      notifications.remind(t0 + minute, [], allDown);
      await notifications.idle();
    } finally {
      stderr.mockRestore();
    }
    expect(reads).toBe(2);
  });
});

describe("an outage that opens during the reminder pass's first read", () => {
  test("an outage that opened while the first pass read the open outages gets no reminder until its first interval ends", async () => {
    const reminding = monitor({ reminderMs: hour });
    // The check started at the tick and its outage opened while the seed read was answering.
    const w = world([{ ...opened, startedAt: t0 + 2 }]);
    await remindAt(w, t0, [reminding]);
    await remindAt(w, t0 + 1000, [reminding]);
    expect(w.queued).toEqual([]);
    await remindAt(w, t0 + 2 + hour, [reminding]);
    expect(w.types()).toEqual(["monitor.reminder"]);
  });
});

describe("a notification the queue refuses", () => {
  const reminding = monitor({ reminderMs: hour });
  const quietly = async (work: () => Promise<void>) => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      await work();
    } finally {
      stderr.mockRestore();
    }
  };

  test("a reminder the queue refuses is tried again at the next pass, not an interval later", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    w.failQueue();
    await quietly(() => remindAt(w, t0 + hour, [reminding]));
    w.queueWorks();
    await remindAt(w, t0 + hour + 1000, [reminding]);
    expect(w.types()).toEqual(["monitor.down", "monitor.reminder"]);
  });

  test("an event the queue refuses is kept and queued at the next pass, before anything newer and before any reminder", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    w.failQueue();
    await quietly(async () => {
      await w.notifications.raise(down, reminding, t0);
      await w.notifications.raise(recovered, reminding, t0 + 30 * minute);
    });
    expect(w.queued).toEqual([]);
    w.queueWorks();
    await w.notifications.raise(down, reminding, t0 + hour);
    await remindAt(w, t0 + 3 * hour, [reminding]);
    expect(w.types()).toEqual([
      "monitor.down",
      "monitor.recovered",
      "monitor.down",
      "monitor.reminder",
    ]);
  });

  test("a certificate warning the queue refuses is not kept: the pass raises it again, and it answers so", async () => {
    const w = world();
    w.failQueue();
    let accepted = true;
    await quietly(async () => {
      accepted = await w.notifications.raise(
        {
          at: t0,
          kind: "certificate_expiring",
          monitorId: "0199",
          validTo: t0 + 5 * day,
          warning: "threshold",
        },
        monitor(),
        t0
      );
    });
    expect(accepted).toBe(false);
    w.queueWorks();
    await remindAt(w, t0 + minute, [monitor()]);
    expect(w.queued).toEqual([]);
  });

  test("a kept event goes out at the next pass even when nothing newer is raised, and before the reminder that repeats it", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    w.failQueue();
    await quietly(async () => {
      await w.notifications.raise(down, reminding, t0);
    });
    w.queueWorks();
    await remindAt(w, t0 + minute, [reminding]);
    expect(w.types()).toEqual(["monitor.down"]);
    await remindAt(w, t0 + hour, [reminding]);
    expect(w.types()).toEqual(["monitor.down", "monitor.reminder"]);
  });
});

describe("a monitor a maintenance window covers", () => {
  const reminding = monitor({ reminderMs: hour });

  test("its events send nothing while it is covered", async () => {
    const w = world([], new Set(["0199"]));
    await w.notifications.raise(down, monitor(), t0);
    await w.notifications.raise(recovered, monitor(), t0 + 90 * minute);
    await w.notifications.raise(
      {
        at: t0,
        kind: "degraded_started",
        monitorId: "0199",
        reason: reasons.slow,
      },
      monitor(),
      t0
    );
    expect(w.queued).toEqual([]);
  });

  test("its reminders wait while it is covered", async () => {
    const covered = new Set<string>();
    const w = world([], covered);
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    covered.add("0199");
    await remindAt(w, t0 + 3 * hour, [reminding]);
    expect(w.types()).toEqual(["monitor.down"]);
  });

  test("once windows completing leave it uncovered while it is still down, its down notification goes then, with its open outage and the open-incident link", async () => {
    const covered = new Set(["0199"]);
    const w = world([], covered);
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    covered.delete("0199");
    const end = t0 + 2 * hour;
    await w.notifications.uncovered(["0199"], end, [reminding]);
    expect(w.queued).toEqual([
      {
        channelIds: ["c1", "c2"],
        now: end,
        payload: {
          data: {
            incidentUrl:
              "https://status.example.test/admin/incidents/new?monitor=0199",
            monitor: sampleMonitorData,
            reason: "timeout",
          },
          timestamp: new Date(end).toISOString(),
          type: "monitor.down",
        },
      },
    ]);
  });

  test("the down notification goes at the end even when one went before the window", async () => {
    const covered = new Set<string>();
    const w = world([], covered);
    await remindAt(w, t0, [monitor()]);
    await w.notifications.raise(down, monitor(), t0);
    covered.add("0199");
    covered.delete("0199");
    await w.notifications.uncovered(["0199"], t0 + hour, [monitor()]);
    expect(w.types()).toEqual(["monitor.down", "monitor.down"]);
  });

  test("a monitor whose outage closed inside the window, paused, deleted, or with the down event off gets nothing when uncovered", async () => {
    const recoveredInside = world([], new Set(["0199"]));
    await recoveredInside.notifications.raise(down, monitor(), t0);
    await recoveredInside.notifications.raise(recovered, monitor(), t0 + hour);
    await recoveredInside.notifications.uncovered(["0199"], t0 + 2 * hour, [
      monitor(),
    ]);
    expect(recoveredInside.queued).toEqual([]);
    for (const monitors of [
      [monitor({ paused: true })],
      [],
      [monitor({ events: ["recovered"] })],
    ]) {
      const w = world([opened]);
      // biome-ignore lint/performance/noAwaitInLoops: each case runs on its own world, one after the other
      await w.notifications.uncovered(["0199"], t0 + hour, monitors);
      expect(w.queued).toEqual([]);
    }
  });

  test("after a restart, an outage still open when the window ends gets its down notification from the open outages", async () => {
    const w = world([opened]);
    await w.notifications.uncovered(["0199"], t0 + hour, [monitor()]);
    expect(w.types()).toEqual(["monitor.down"]);
    expect(w.outageReads.count).toBe(1);
  });

  test("the next reminder counts from the down notification the window's end sent", async () => {
    const covered = new Set(["0199"]);
    const w = world([], covered);
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    covered.delete("0199");
    const end = t0 + 2 * hour + 30 * minute;
    await w.notifications.uncovered(["0199"], end, [reminding]);
    await remindAt(w, t0 + 3 * hour - 1, [reminding]);
    expect(w.types()).toEqual(["monitor.down"]);
    await remindAt(w, t0 + 3 * hour, [reminding]);
    expect(w.types()).toEqual(["monitor.down", "monitor.reminder"]);
  });

  test("a down notification the queue refuses at the end is kept and queued at the next pass", async () => {
    const w = world([opened]);
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      w.failQueue();
      await w.notifications.uncovered(["0199"], t0 + hour, [monitor()]);
      expect(w.queued).toEqual([]);
      w.queueWorks();
      await remindAt(w, t0 + hour + 1, [monitor()]);
      expect(w.types()).toEqual(["monitor.down"]);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("edges of a covered monitor's notifications", () => {
  test("a certificate warning of a covered monitor is not sent and answers not queued, so the pass raises it again", async () => {
    const w = world([], new Set(["0199"]));
    const warning: MonitorEvent = {
      at: t0,
      kind: "certificate_expiring",
      monitorId: "0199",
      validTo: t0 + 10 * day,
      warning: "threshold",
    };
    expect(await w.notifications.raise(warning, monitor(), t0)).toBe(false);
    expect(w.queued).toEqual([]);
  });

  test("a window's end during the first reminder pass waits for it, so the open outages are read once", async () => {
    const w = world([opened]);
    w.notifications.remind(t0 + hour, [monitor()], allDown);
    await w.notifications.uncovered(["0199"], t0 + hour, [monitor()]);
    expect(w.outageReads.count).toBe(1);
    expect(w.types()).toEqual(["monitor.down"]);
  });
});

describe("a monitor that recovers and goes down again as a window ends", () => {
  test("a monitor that recovers and goes down again between a window's end and its notification sends one down, not two", async () => {
    const covered = new Set(["0199"]);
    const w = world([], covered);
    // The first pass reads the open outages, as the scheduler's does at boot.
    await remindAt(w, t0, [monitor()]);
    await w.notifications.raise(down, monitor(), t0);
    // A reminder pass under way holds the window's end until it finishes.
    w.notifications.remind(t0 + hour, [monitor()], allDown);
    covered.delete("0199");
    const ending = w.notifications.uncovered(["0199"], t0 + hour, [monitor()]);
    const again: Outage = { ...opened, startedAt: t0 + hour + 1 };
    await w.notifications.raise(
      { ...recovered, at: t0 + hour },
      monitor(),
      t0 + hour
    );
    await w.notifications.raise(
      { ...down, at: again.startedAt, outage: again },
      monitor(),
      t0 + hour + 1
    );
    await ending;
    await w.notifications.idle();
    expect(w.types().filter((type) => type === "monitor.down")).toHaveLength(1);
  });
});

describe("a window's end whose open outages cannot be read yet", () => {
  test("a window's end whose open outages cannot be read yet sends the down notification once they are, before any reminder", async () => {
    let reads = 0;
    const queued: NotificationPayload[] = [];
    const notifications = createOperatorNotifications(
      {
        outages: {
          acknowledge: () => Promise.resolve(undefined),
          close: () => Promise.resolve(undefined),
          list: () => Promise.resolve([]),
          since: () => Promise.resolve(new Map()),
          ongoing: () => {
            reads += 1;
            return reads === 1
              ? Promise.reject(new Error("the database did not answer"))
              : Promise.resolve([opened]);
          },
          open: () => Promise.resolve(false),
        },
      },
      {
        enqueue: (_channelIds, payload) => {
          queued.push(payload);
          return Promise.resolve();
        },
      },
      { context: () => address, isStopped: () => false }
    );
    const reminding = monitor({ reminderMs: minute });
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      // The outage predates this process, so only the read knows it.
      await notifications.uncovered(["0199"], t0 + hour, [reminding]);
      expect(queued).toEqual([]);
      notifications.remind(t0 + 2 * hour, [reminding], allDown);
      await notifications.idle();
    } finally {
      stderr.mockRestore();
    }
    expect(queued.map((payload) => payload.type)).toEqual(["monitor.down"]);
  });
});

describe('an acknowledged outage (CONTEXT.md "Acknowledge")', () => {
  const reminding = monitor({ reminderMs: hour });

  test("reminds no more from the moment it is acknowledged, and its recovered notification still goes", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    await remindAt(w, t0 + hour, [reminding]);
    w.notifications.acknowledge({ ...opened, acknowledgedAt: t0 + hour + 1 });
    await remindAt(w, t0 + 2 * hour, [reminding]);
    await remindAt(w, t0 + 5 * hour, [reminding]);
    await w.notifications.raise(
      { ...recovered, at: t0 + 6 * hour },
      reminding,
      t0 + 6 * hour
    );
    expect(w.types()).toEqual([
      "monitor.down",
      "monitor.reminder",
      "monitor.recovered",
    ]);
  });

  test("the next outage reminds again", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    w.notifications.acknowledge({ ...opened, acknowledgedAt: t0 + 1 });
    await w.notifications.raise(recovered, reminding, t0 + 90 * minute);
    const later = t0 + 2 * hour;
    await w.notifications.raise(
      { ...down, at: later, outage: { ...opened, startedAt: later } },
      reminding,
      later
    );
    await remindAt(w, later + hour, [reminding]);
    expect(w.types()).toEqual([
      "monitor.down",
      "monitor.recovered",
      "monitor.down",
      "monitor.reminder",
    ]);
  });

  test("after a restart, an outage acknowledged before reminds no more", async () => {
    const w = world([{ ...opened, acknowledgedAt: t0 + minute }]);
    await remindAt(w, t0 + 5 * hour + 10 * minute, [reminding]);
    await remindAt(w, t0 + 8 * hour, [reminding]);
    expect(w.queued).toEqual([]);
  });

  test("an acknowledgement of another outage than the one open leaves its reminders alone", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    w.notifications.acknowledge({
      ...opened,
      acknowledgedAt: t0 + 1,
      startedAt: t0 - day,
    });
    w.notifications.acknowledge({
      ...opened,
      acknowledgedAt: t0 + 1,
      monitorId: "another",
    });
    await remindAt(w, t0 + hour, [reminding]);
    expect(w.types()).toEqual(["monitor.down", "monitor.reminder"]);
  });

  test("a window's end still sends the down notification of an acknowledged outage, which stops only reminders", async () => {
    const covered = new Set(["0199"]);
    const w = world([], covered);
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    w.notifications.acknowledge({ ...opened, acknowledgedAt: t0 + 1 });
    covered.clear();
    await w.notifications.uncovered(["0199"], t0 + hour, [reminding]);
    await remindAt(w, t0 + 3 * hour, [reminding]);
    expect(w.types()).toEqual(["monitor.down"]);
  });
});

describe("an acknowledgement that lands while the reminder state is moving", () => {
  const reminding = monitor({ reminderMs: hour });
  const acknowledged = { ...opened, acknowledgedAt: t0 + minute };

  test("one made while the first pass reads the open outages, which read it as not yet acknowledged, still stops the reminders", async () => {
    const w = world([opened]);
    w.hooks.duringOngoing = () => {
      w.notifications.acknowledge(acknowledged);
      return Promise.resolve();
    };
    await remindAt(w, t0 + 5 * hour + 10 * minute, [reminding]);
    await remindAt(w, t0 + 8 * hour, [reminding]);
    expect(w.queued).toEqual([]);
  });

  test("one made between the outage opening and its down event still stops the reminders", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    w.notifications.acknowledge(acknowledged);
    await w.notifications.raise(down, reminding, t0);
    await remindAt(w, t0 + 3 * hour, [reminding]);
    expect(w.types()).toEqual(["monitor.down"]);
  });

  test("one of an outage that recovered before its down event is forgotten, so the next outage reminds", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    w.notifications.acknowledge(acknowledged);
    await w.notifications.raise(recovered, reminding, t0 + 90 * minute);
    const later = t0 + 2 * hour;
    await w.notifications.raise(
      { ...down, at: later, outage: { ...opened, startedAt: later } },
      reminding,
      later
    );
    await remindAt(w, later + hour, [reminding]);
    expect(w.types()).toEqual([
      "monitor.recovered",
      "monitor.down",
      "monitor.reminder",
    ]);
  });

  test("one made while a reminder is being queued stops the next reminder", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    w.hooks.duringEnqueue = (payload) => {
      if (payload.type === "monitor.reminder") {
        w.notifications.acknowledge(acknowledged);
      }
    };
    await remindAt(w, t0 + hour, [reminding]);
    await remindAt(w, t0 + 3 * hour, [reminding]);
    expect(w.types()).toEqual(["monitor.down", "monitor.reminder"]);
  });

  test("a recovery while a reminder is being queued is not undone by it: no reminder follows", async () => {
    const w = world();
    await remindAt(w, t0, [reminding]);
    await w.notifications.raise(down, reminding, t0);
    w.hooks.duringEnqueue = (payload) => {
      if (payload.type === "monitor.reminder") {
        w.notifications
          .raise(recovered, reminding, t0 + hour)
          .catch(() => undefined);
      }
    };
    await remindAt(w, t0 + hour, [reminding]);
    w.hooks.duringEnqueue = undefined;
    await remindAt(w, t0 + 3 * hour, [reminding]);
    expect(w.types()).toEqual([
      "monitor.down",
      "monitor.reminder",
      "monitor.recovered",
    ]);
  });
});
