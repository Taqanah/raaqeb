/**
 * Operator notifications (CONTEXT.md "Operator notification", "Reminder"):
 * what a monitor event sends to the monitor's channels, and
 * the reminders while it stays down. The rules run before any channel is
 * invoked: an event the monitor switched off, or one that cannot
 * happen for it, sends nothing; down and recovered follow the outage record,
 * so a check that lands after a pause sends neither. A reminder
 * falls at the outage's start plus a whole multiple of the monitor's
 * interval, repeats only while the down event is on, and needs no stored
 * state: after a restart the next one is the next multiple, and the ones
 * missed while stopped are not sent. A notification
 * the queue refuses is not lost: a check event's waits in memory and goes
 * first at the next pass, a reminder is tried again at the next pass, and
 * a certificate warning is raised again by the certificate pass. A monitor
 * a maintenance window covers notifies nothing and gets no reminder; when
 * windows completing leave it uncovered while it is still down, its down
 * notification goes then, whether or not one went before. An outage the operator acknowledged reminds no more; its
 * recovered notification and the next outage's reminders go as usual.
 */
import type { z } from "zod";
import { error as logError, reasonOf } from "@/server/log.ts";
import type { MonitorEvent } from "@/server/scheduler/schedule.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { daysLeft } from "@/shared/domain/certificates.ts";
import { notifies } from "@/shared/domain/events.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type {
  NotificationPayload,
  notificationMonitorSchema,
} from "@/shared/schemas/notification.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import {
  type ReasonCode,
  type ReasonName,
  reasonName,
} from "@/shared/schemas/reason.ts";
import type { NotificationQueue } from "./queue.ts";

/** Where an operator notification's links point: the stored public address, or nothing when none is stored. */
export interface OperatorContext {
  readonly publicAddress: string | undefined;
}

type NotificationMonitor = z.infer<typeof notificationMonitorSchema>;

const iso = (ms: number): string => new Date(ms).toISOString();

const nameOf = (code: ReasonCode): ReasonName => reasonName(code) ?? "unknown";

/** The monitor as a notification names it, with its page in the admin area when a public address is stored. */
function monitorOf(
  monitor: Monitor,
  { publicAddress }: OperatorContext
): NotificationMonitor {
  return {
    ...(publicAddress !== undefined && {
      adminUrl: `${publicAddress}/admin/monitors/${encodeURIComponent(monitor.id)}`,
    }),
    checkType: monitor.config.type,
    id: monitor.id,
    name: monitor.name,
    target: monitor.target ?? null,
  };
}

/** The notification a monitor event sends, or nothing when the monitor does not notify it. */
export function notificationOf(
  event: MonitorEvent,
  monitor: Monitor,
  context: OperatorContext
): NotificationPayload | undefined {
  if (!notifies(monitor, event.kind)) {
    return;
  }
  const timestamp = iso(event.at);
  const named = monitorOf(monitor, context);
  switch (event.kind) {
    case "down": {
      if (!event.outage) {
        return;
      }
      const { publicAddress } = context;
      return {
        data: {
          ...(publicAddress !== undefined && {
            incidentUrl: `${publicAddress}/admin/incidents/new?monitor=${encodeURIComponent(monitor.id)}`,
          }),
          monitor: named,
          reason: nameOf(event.reason),
        },
        timestamp,
        type: "monitor.down",
      };
    }
    case "recovered": {
      const { outage } = event;
      if (outage?.endedAt === undefined) {
        return;
      }
      return {
        data: { downtimeMs: outage.endedAt - outage.startedAt, monitor: named },
        timestamp,
        type: "monitor.recovered",
      };
    }
    case "degraded_started":
      return {
        data: { monitor: named, reason: nameOf(event.reason) },
        timestamp,
        type: "monitor.degraded_started",
      };
    case "degraded_ended":
      return {
        data: { monitor: named },
        timestamp,
        type: "monitor.degraded_ended",
      };
    default:
      return {
        data: {
          certificate: {
            daysLeft: daysLeft(event.validTo, event.at),
            notAfter: iso(event.validTo),
          },
          monitor: named,
        },
        timestamp,
        type: "monitor.certificate_expiring",
      };
  }
}

/** A reminder's notification: the monitor is still down, `now` minus the outage's start after it went down. */
export function reminderOf(
  monitor: Monitor,
  outage: Outage,
  context: OperatorContext,
  now: number
): NotificationPayload {
  return {
    data: {
      downForMs: now - outage.startedAt,
      monitor: monitorOf(monitor, context),
      reason: nameOf(outage.reason),
    },
    timestamp: iso(now),
    type: "monitor.reminder",
  };
}

/** When the next reminder of an outage that started at `startedAt` falls: the first whole multiple of the interval after it that is later than `sentAt`, the last send. */
export function nextReminderAt(
  startedAt: number,
  reminderMs: number,
  sentAt: number
): number {
  const sent = Math.floor((sentAt - startedAt) / reminderMs);
  return startedAt + reminderMs * (sent + 1);
}

export interface OperatorNotificationsOptions {
  /** The stored public address as the scheduler last read it. */
  readonly context: () => OperatorContext;
  /** Whether a maintenance window in progress covers the monitor now, which suppresses its notifications and reminders; absent, none is covered. */
  readonly covers?: (monitorId: string) => boolean;
  /** Whether the scheduler has stopped; nothing new is queued. */
  readonly isStopped: () => boolean;
}

export interface OperatorNotifications {
  /** The operator acknowledged this outage: its reminders stop, and nothing else changes. One the notifications do not hold yet is remembered until its entry is stored, its outage recovers or another opens. */
  acknowledge: (outage: Outage) => void;
  /** Monitors appeared with their history, as an import writes them: the next pass reads the open outages again and takes up the ones it does not know. */
  adopt: () => void;
  /** Resolves once no reminder pass is under way; tests wait on it, and stop does. */
  idle: () => Promise<void>;
  /** Queues what the event sends for each of the monitor's channels, and starts or ends the outage's reminders. A check event the queue refuses is kept and queued again at the next pass; a certificate warning is not, and the answer is false so the pass raises it again. Never throws; a failure is logged. */
  raise: (
    event: MonitorEvent,
    monitor: Monitor,
    now: number
  ) => Promise<boolean>;
  /** On the tick: queues the reminders that are due for the monitors that are still down and not covered. Never waits for it and never throws. */
  remind: (
    now: number,
    monitors: readonly Monitor[],
    isDown: (monitorId: string) => boolean
  ) => void;
  /** Windows completing left these monitors uncovered: each still down, with its outage open, gets its down notification now, whether or not one went before the window. Kept and queued again like a check event's when the queue refuses it. Never throws. */
  uncovered: (
    monitorIds: readonly string[],
    now: number,
    monitors: readonly Monitor[]
  ) => Promise<void>;
}

export function createOperatorNotifications(
  storage: Pick<Storage, "outages">,
  queue: Pick<NotificationQueue, "enqueue">,
  options: OperatorNotificationsOptions
): OperatorNotifications {
  /** Each monitor's open outage, when its last notification went, down or reminder, and whether the operator acknowledged it, which ends its reminders. */
  const down = new Map<
    string,
    { acknowledged: boolean; outage: Outage; sentAt: number }
  >();
  /** An acknowledgement that came before its outage's entry (during the boot read, or between the outage opening and its down event): each monitor's acknowledged outage by its start, taken up when that outage's entry is stored. */
  const acknowledgedEarly = new Map<string, number>();
  const isAcknowledged = (outage: Outage): boolean =>
    outage.acknowledgedAt !== undefined ||
    acknowledgedEarly.get(outage.monitorId) === outage.startedAt;
  /** Whether the outages open at boot are known, so their reminders go on after a restart. */
  let seeded = false;
  let pass: Promise<void> | undefined;
  // ponytail: no cap; one database failure holds only the state changes it spans, a handful per monitor.
  /** The check events' notifications the queue refused, oldest first; each is queued again before anything newer. Held in memory, so a restart before the database answers again loses them. */
  const unsent: {
    readonly monitor: Monitor;
    readonly now: number;
    readonly payload: NotificationPayload;
  }[] = [];
  let flushing: Promise<boolean> | undefined;
  /** The monitors a window's end uncovered before the open outages could be read; their down notification goes at the pass that reads them. */
  const endsWaiting = new Set<string>();

  /** Queues the notification for the monitor's channels; answers whether it is queued, or had nowhere to go. */
  async function send(
    monitor: Monitor,
    payload: NotificationPayload,
    now: number
  ): Promise<boolean> {
    if (monitor.channels.length === 0) {
      return true;
    }
    try {
      await queue.enqueue(monitor.channels, payload, now);
      return true;
    } catch (error) {
      logError(
        `the ${payload.type} notification of the monitor ${monitor.id} was not queued: ${reasonOf(error)}`
      );
      return false;
    }
  }

  /** Queues the kept notifications in order; answers whether none is left. One flush at a time, so none is queued twice. */
  function flush(): Promise<boolean> {
    flushing ??= (async () => {
      while (unsent.length > 0) {
        const [head] = unsent;
        // biome-ignore lint/performance/noAwaitInLoops: in order, and the first refusal stops the flush
        if (!(head && (await send(head.monitor, head.payload, head.now)))) {
          return false;
        }
        unsent.shift();
      }
      return true;
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  async function seed(now: number): Promise<boolean> {
    try {
      for (const outage of await storage.outages.ongoing()) {
        if (down.has(outage.monitorId)) {
          continue;
        }
        // Reminders missed while stopped are not sent: the next one is the next multiple after boot. An outage that opened during this read counts from its own start.
        down.set(outage.monitorId, {
          acknowledged: isAcknowledged(outage),
          outage,
          sentAt: Math.max(now, outage.startedAt),
        });
      }
      return true;
    } catch (error) {
      logError(
        `the open outages could not be read for their reminders: ${reasonOf(error)}`
      );
      return false;
    }
  }

  async function remindDue(
    now: number,
    monitors: readonly Monitor[],
    isDown: (monitorId: string) => boolean
  ): Promise<void> {
    if (!(await readyToRemind(now, monitors))) {
      return;
    }
    const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
    for (const [id, entry] of down) {
      const monitor = byId.get(id);
      if (!monitor || monitor.paused || !isDown(id)) {
        down.delete(id);
        continue;
      }
      if (entry.acknowledged || options.covers?.(id)) {
        continue;
      }
      const { reminderMs } = monitor;
      if (
        reminderMs === undefined ||
        !notifies(monitor, "down") ||
        now < nextReminderAt(entry.outage.startedAt, reminderMs, entry.sentAt)
      ) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one queue write per due reminder, rare
      const sent = await send(
        monitor,
        reminderOf(monitor, entry.outage, options.context(), now),
        now
      );
      // A reminder the queue refused is tried again at the next pass. The entry is read again after the write, so an acknowledgement or a recovery made meanwhile stands.
      const live = down.get(id);
      if (sent && live?.outage === entry.outage) {
        down.set(id, { ...live, sentAt: now });
      }
    }
  }

  /** Queues the down notification of each uncovered monitor still down, which its open outage says, and counts its reminders from it. `found` is each open outage as the window's end found it, once they are known: one that closed or opened again since sent its own notification. */
  function queueEnds(
    monitorIds: Iterable<string>,
    now: number,
    monitors: readonly Monitor[],
    found: ReadonlyMap<string, Outage> | undefined
  ): void {
    const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
    for (const id of monitorIds) {
      const entry = down.get(id);
      const monitor = byId.get(id);
      if (
        !(entry && monitor) ||
        monitor.paused ||
        (found !== undefined && found.get(id) !== entry.outage)
      ) {
        continue;
      }
      const { outage } = entry;
      const payload = notificationOf(
        { at: now, kind: "down", monitorId: id, outage, reason: outage.reason },
        monitor,
        options.context()
      );
      down.set(id, { ...entry, sentAt: now });
      if (payload) {
        unsent.push({ monitor, now, payload });
      }
    }
  }

  /** Reads the open outages once, queues the window ends that waited for them, and sends what is kept; answers whether reminders may go, since a reminder never goes before the down notification it repeats. */
  async function readyToRemind(
    now: number,
    monitors: readonly Monitor[]
  ): Promise<boolean> {
    seeded ||= await seed(now);
    if (!seeded) {
      return false;
    }
    queueEnds(endsWaiting, now, monitors, undefined);
    endsWaiting.clear();
    return await flush();
  }

  /** The down notifications of a window's end; when the open outages cannot be read yet, they wait for the next pass that reads them. */
  async function downAtEnd(
    monitorIds: readonly string[],
    now: number,
    monitors: readonly Monitor[],
    found: ReadonlyMap<string, Outage> | undefined
  ): Promise<void> {
    seeded ||= await seed(now);
    if (!seeded) {
      for (const id of monitorIds) {
        endsWaiting.add(id);
      }
      return;
    }
    queueEnds(monitorIds, now, monitors, found);
    await flush();
  }

  return {
    acknowledge: (outage) => {
      const entry = down.get(outage.monitorId);
      // The entry keeps its outage as it is, so a window's end still knows it for its down notification.
      if (entry?.outage.startedAt === outage.startedAt) {
        down.set(outage.monitorId, { ...entry, acknowledged: true });
      } else {
        acknowledgedEarly.set(outage.monitorId, outage.startedAt);
      }
    },
    adopt: () => {
      seeded = false;
    },
    idle: async () => {
      await pass;
      await flushing;
    },
    raise: async (event, monitor, now) => {
      if (event.kind === "down" && event.outage) {
        down.set(event.monitorId, {
          acknowledged: isAcknowledged(event.outage),
          outage: event.outage,
          sentAt: event.outage.startedAt,
        });
        // Taken up, or of an outage this one replaced.
        acknowledgedEarly.delete(event.monitorId);
      } else if (event.kind === "recovered") {
        down.delete(event.monitorId);
        acknowledgedEarly.delete(event.monitorId);
      }
      // A covered monitor notifies nothing; its outage stays known for the notification at the window's end, and a certificate warning answers not queued, so it is raised again once the window ends.
      if (options.covers?.(monitor.id)) {
        return event.kind !== "certificate_expiring";
      }
      const payload = notificationOf(event, monitor, options.context());
      if (!payload) {
        return true;
      }
      // The certificate pass raises a refused warning again itself, and a restart does not lose it.
      if (event.kind === "certificate_expiring") {
        return await send(monitor, payload, now);
      }
      unsent.push({ monitor, now, payload });
      await flush();
      return true;
    },
    remind: (now, monitors, isDown) => {
      if (pass !== undefined || options.isStopped()) {
        return;
      }
      const current: Promise<void> = remindDue(now, monitors, isDown).finally(
        () => {
          if (pass === current) {
            pass = undefined;
          }
        }
      );
      pass = current;
    },
    uncovered: async (monitorIds, now, monitors) => {
      // The open outages as the window's end finds them, before anything can move them.
      const found = seeded
        ? new Map(
            monitorIds.flatMap((id) => {
              const entry = down.get(id);
              return entry ? [[id, entry.outage] as const] : [];
            })
          )
        : undefined;
      // After any pass under way and in its place, so a reminder and this never interleave.
      const previous = pass;
      const current = (async () => {
        await previous;
        await downAtEnd(monitorIds, now, monitors, found);
      })();
      pass = current;
      try {
        await current;
      } finally {
        if (pass === current) {
          pass = undefined;
        }
      }
    },
  };
}
