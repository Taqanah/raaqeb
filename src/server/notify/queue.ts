/**
 * The notification queue's drain: every notification is stored
 * before it is sent and tried again three times with backoff, 30 seconds,
 * 2 minutes and 10 minutes after each failure, so four attempts over about
 * 12.5 minutes. It runs on the scheduler's tick, on
 * the one event loop. It keeps the next due time in memory, so an empty
 * queue costs no query: it reads it once at its first run and again after
 * each delivery it settles, and queuing lowers it. At most four
 * deliveries run at once, one per lane, oldest queued first, so a lane's
 * notifications arrive in order; a lane is a channel, or a subscriber's
 * subscription, whose notification its subscription may no
 * longer take by the time it goes, which drops it. Delivery is at least once: a
 * delivery still in flight when the scheduler stops is not settled and is
 * sent again at the next boot, with the same `webhook-id`. A read of the
 * queue that fails is tried again a minute later.
 */

import type { InstallKey } from "@/server/boot/installkey.ts";
import { error as logError, reasonOf } from "@/server/log.ts";
import { readClock } from "@/server/settings/clock.ts";
import { readInstallLanguage } from "@/server/settings/language.ts";
import {
  laneOf,
  type NotificationSettlement,
  type QueuedNotification,
} from "@/server/storage/notifications.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type {
  Notification,
  NotificationPayload,
  SendFailure,
} from "@/shared/schemas/notification.ts";
import type { SubscriberPayload } from "@/shared/schemas/subscription.ts";
import { type DeliverIo, deliver, type SendOutcome } from "./channel.ts";
import { notificationChannels } from "./registry.ts";
import { channelValues, unreadableSecrets } from "./secrets.ts";
import { sendToSubscriber } from "./subscribers.ts";

/** How long after each failed attempt the next one runs; one entry per retry. */
export const retryDelaysMs: readonly number[] = [30_000, 120_000, 600_000];

/** Deliveries in flight at once. */
export const deliveriesInFlight = 4;

/** Each channel keeps this many finished notifications as its recent sends. */
export const sendsKept = 50;

/** Each subscription keeps this many: the admin reads the newest, and the one before stays for debugging. */
export const subscriberSendsKept = 2;

/** A read of the queue that failed is tried again this long after, so a database outage or a row this version cannot read logs once a minute, not once a tick. */
export const readRetryMs = 60_000;

/** When a notification is tried again after its `attempts`th failed attempt, or nothing once the retries are spent. */
export function nextAttemptAt(
  attempts: number,
  failedAt: number
): number | undefined {
  const delay = retryDelaysMs[attempts - 1];
  return delay === undefined ? undefined : failedAt + delay;
}

export type QueueStorage = Pick<
  Storage,
  "channels" | "notifications" | "pages" | "settings" | "subscriptions"
>;

export interface QueueOptions {
  /** Opens each channel's sealed secrets at delivery. */
  readonly installKey: InstallKey;
  /** Whether the scheduler has stopped; nothing new starts and an attempt that ends later is not settled. */
  readonly isStopped: () => boolean;
}

export interface NotificationQueue {
  /** Queues an operator notification for each channel, due at `now`. */
  enqueue: (
    channelIds: readonly string[],
    payload: NotificationPayload,
    now: number
  ) => Promise<void>;
  /** Queues a subscriber notification for each subscription, due at `now`. */
  enqueueSubscribers: (
    subscriptionIds: readonly string[],
    payload: SubscriberPayload,
    now: number
  ) => Promise<void>;
  /** Waits for a settlement under way; once the scheduler stops, the last thing the queue does to storage. Never waits for an attempt on the network. */
  flush: () => Promise<void>;
  /** Resolves once no delivery is in flight and no read is under way; tests wait on it. */
  idle: () => Promise<void>;
  /** On the tick: starts what is due, up to the cap. Never waits for it and never throws; a failure is logged. */
  run: (now: number) => void;
}

export function createNotificationQueue(
  storage: QueueStorage,
  io: DeliverIo,
  options: QueueOptions
): NotificationQueue {
  /** Whether `nextDue` holds what storage says; false until the first run and after each settlement. */
  let known = false;
  /** When the earliest notification that may go is due; nothing when none waits. */
  let nextDue: number | undefined;
  /** A read of what is due, under way. */
  let reading: Promise<void> | undefined;
  /** After a read failed, the next one waits until then. */
  let readAgainAt: number | undefined;
  /** A notification was queued while a read was answering, so what that read saw may be stale. */
  let movedDuringRead = false;
  /** The delivery on the network for each channel. */
  const inFlight = new Map<string, Promise<void>>();
  /** Settlements being written. */
  const writes = new Set<Promise<unknown>>();

  function track<T>(write: Promise<T>): Promise<T> {
    writes.add(write);
    return write.finally(() => writes.delete(write));
  }

  async function startDue(now: number): Promise<void> {
    if (!known) {
      nextDue = await storage.notifications.nextDueAt();
      known = true;
    }
    const room = deliveriesInFlight - inFlight.size;
    if (nextDue === undefined || nextDue > now || room <= 0) {
      return;
    }
    const due = await storage.notifications.due(now, room, [
      ...inFlight.keys(),
    ]);
    if (due.length === 0) {
      if (inFlight.size > 0) {
        // What is due is on the network already; its settlement reads the next due time again.
        nextDue = undefined;
      } else {
        known = false;
      }
      return;
    }
    for (const notification of due) {
      if (options.isStopped()) {
        return;
      }
      const delivery = attempt(notification)
        .catch((error: unknown) => {
          logError(
            `the notification ${notification.id} could not be settled: ${reasonOf(error)}`
          );
        })
        .finally(() => {
          inFlight.delete(laneOf(notification));
          known = false;
          // The next due one goes at once rather than at the next tick; a read under way picks it up itself.
          run(io.now());
        });
      inFlight.set(laneOf(notification), delivery);
    }
  }

  /** One attempt of one notification and its settlement; nothing is settled once the scheduler stopped. */
  async function attempt(notification: QueuedNotification): Promise<void> {
    const outcome =
      notification.kind === "subscriber"
        ? await sendToSubscriber(storage, options.installKey, io, notification)
        : await send(notification);
    if (options.isStopped()) {
      return;
    }
    if (outcome === "dropped") {
      // Its subscription no longer takes it: nothing to retry and nothing to show.
      await track(storage.notifications.drop(notification.id));
      return;
    }
    const at = io.now();
    const settlement = settlementOf(outcome, notification.attempts + 1, at);
    if (!outcome.ok) {
      logFailure(notification, outcome.failure, settlement, at);
    }
    const stored = await track(
      storage.notifications.settle(notification.id, settlement)
    );
    // A channel or subscription deleted meanwhile took the notification with it; after stop the settlement is the last write.
    if (stored && settlement.status !== "pending" && !options.isStopped()) {
      const kept =
        notification.kind === "subscriber" ? subscriberSendsKept : sendsKept;
      await track(storage.notifications.prune(laneOf(notification), kept));
    }
  }

  /** The attempt's outcome; a channel that cannot be read fails the attempt, which then waits like any other. */
  async function send(notification: Notification): Promise<SendOutcome> {
    try {
      const channel = await storage.channels.find(notification.channelId);
      if (!channel) {
        return { failure: unreadableSecrets, ok: false };
      }
      const [values, installLocale, time] = await Promise.all([
        storage.channels
          .credentialsOf(channel.id)
          .then((sealed) => channelValues(options.installKey, channel, sealed)),
        readInstallLanguage(storage),
        readClock(storage),
      ]);
      if (!values) {
        return { failure: unreadableSecrets, ok: false };
      }
      return await deliver(
        notificationChannels[channel.type],
        values,
        {
          id: notification.id,
          locale: channel.locale ?? installLocale,
          notification: notification.payload,
          time,
        },
        io
      );
    } catch (error) {
      return {
        failure: {
          error: reasonOf(error),
          params: { reason: "unknown" },
          reason: "unknown",
        },
        ok: false,
      };
    }
  }

  /** A notification queued due at `now`: the next due time comes down to it, or the read under way reads again. */
  function lowered(now: number): void {
    if (reading !== undefined) {
      movedDuringRead = true;
    } else if (known) {
      nextDue = nextDue === undefined ? now : Math.min(nextDue, now);
    }
  }

  function run(now: number): void {
    if (
      reading !== undefined ||
      options.isStopped() ||
      (readAgainAt !== undefined && now < readAgainAt)
    ) {
      return;
    }
    readAgainAt = undefined;
    reading = startDue(now)
      .catch((error: unknown) => {
        known = false;
        readAgainAt = now + readRetryMs;
        logError(
          `the notification queue could not be read: ${reasonOf(error)}`
        );
      })
      .finally(() => {
        reading = undefined;
        if (movedDuringRead) {
          movedDuringRead = false;
          known = false;
          run(io.now());
        }
      });
  }

  return {
    enqueue: async (channelIds, payload, now) => {
      const queued = await storage.notifications.enqueue(
        channelIds,
        "operator",
        payload,
        now
      );
      if (queued.length > 0) {
        lowered(now);
      }
    },
    enqueueSubscribers: async (subscriptionIds, payload, now) => {
      const queued = await storage.notifications.enqueueSubscribers(
        subscriptionIds,
        payload,
        now
      );
      if (queued.length > 0) {
        lowered(now);
      }
    },
    flush: async () => {
      // A settlement that fails is logged; flush only waits for it.
      await Promise.all(
        [...writes].map((write) => write.catch(() => undefined))
      );
    },
    idle: async () => {
      while (reading !== undefined || inFlight.size > 0) {
        // biome-ignore lint/performance/noAwaitInLoops: a settled delivery may start the next one
        await Promise.all([reading, ...inFlight.values()]);
      }
    },
    run,
  };
}

/** What an attempt's outcome leaves on its notification: sent, a retry at its backoff, or failed for good. */
function settlementOf(
  outcome: SendOutcome,
  attempts: number,
  at: number
): NotificationSettlement {
  if (outcome.ok) {
    return { at, attempts, status: "sent" };
  }
  const next = nextAttemptAt(attempts, at);
  return next === undefined
    ? { at, attempts, failure: outcome.failure, status: "failed" }
    : {
        attempts,
        failure: outcome.failure,
        nextAttemptAt: next,
        status: "pending",
      };
}

/** One log line for a failed attempt: where it went, why, and when it is tried again. */
function logFailure(
  notification: QueuedNotification,
  failure: SendFailure,
  settlement: NotificationSettlement,
  at: number
): void {
  const to =
    notification.kind === "subscriber"
      ? `the subscription ${notification.subscriptionId}`
      : `the channel ${notification.channelId}`;
  const retry =
    settlement.status === "pending"
      ? `; tried again in ${Math.round((settlement.nextAttemptAt - at) / 1000)} s`
      : "; no retry is left";
  logError(
    `the notification ${notification.id} to ${to} failed (${failure.reason})${retry}`
  );
}
