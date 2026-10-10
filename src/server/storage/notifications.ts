/**
 * The notifications repository: the queue and the recent
 * sends in one table, of channels and subscriptions alike. A pending
 * notification waits for its next attempt; a sent or failed one records how
 * its last attempt went. A notification's lane is its channel or its
 * subscription: a lane's notifications go out in the order they were
 * queued, so a lane whose oldest pending notification is not due yet sends
 * nothing newer. Rows never leave this file:
 * every answer is a `Notification` or a `SubscriberNotification` of
 * shared/schemas.
 */
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type ChannelNotificationKind,
  type Notification,
  type NotificationPayload,
  notificationKinds,
  notificationPayloadSchema,
  notificationStatuses,
  type SendFailure,
} from "@/shared/schemas/notification.ts";
import {
  reasonName,
  reasonParamsSchema,
  reasons,
} from "@/shared/schemas/reason.ts";
import {
  type SubscriberNotification,
  type SubscriberPayload,
  subscriberPayloadSchema,
} from "@/shared/schemas/subscription.ts";
import type { Executor } from "./connection.ts";

/** What one attempt left: delivered, given up, or waiting until a later time. */
export type NotificationSettlement =
  | { readonly status: "sent"; readonly attempts: number; readonly at: number }
  | {
      readonly status: "failed";
      readonly attempts: number;
      readonly at: number;
      readonly failure: SendFailure;
    }
  | {
      readonly status: "pending";
      readonly attempts: number;
      readonly failure: SendFailure;
      readonly nextAttemptAt: number;
    };

/** Rows a statement writes at most: a row has twelve parameters, and both backends cap a statement at 65,535 (Postgres by its protocol; Bun's SQLite numbers them in 16 bits past that, probed on this branch). */
const rowsPerInsert = 500;

/** A notification the queue holds: for a channel or for a subscription. */
export type QueuedNotification = Notification | SubscriberNotification;

/** The lane a notification waits in: its channel, or its subscription. */
export function laneOf(notification: QueuedNotification): string {
  return notification.kind === "subscriber"
    ? notification.subscriptionId
    : notification.channelId;
}

/** A notification that finished without waiting in the queue: a "send test", recorded as it ended. */
export interface FinishedNotification {
  readonly channelId: string;
  /** The id its attempt carried, which the receiver saw as `webhook-id`; a new one when absent. */
  readonly id?: string;
  readonly kind: ChannelNotificationKind;
  readonly payload: NotificationPayload;
  readonly queuedAt: number;
  readonly settlement: Extract<
    NotificationSettlement,
    { status: "sent" | "failed" }
  >;
}

export interface NotificationsRepository {
  /** Deletes a notification that will never be sent: its subscription no longer takes it. */
  drop: (id: string) => Promise<void>;
  /** Up to `limit` pending notifications due at `now`, each the oldest pending one of its lane, leaving out the lanes named (channel or subscription ids); the earliest due first. */
  due: (
    now: number,
    limit: number,
    busyLanes: readonly string[]
  ) => Promise<QueuedNotification[]>;
  /** Queues one pending notification for each channel, due at `at`; answers them in the order of the channels. */
  enqueue: (
    channelIds: readonly string[],
    kind: ChannelNotificationKind,
    payload: NotificationPayload,
    at: number
  ) => Promise<Notification[]>;
  /** Queues one pending subscriber notification for each subscription, due at `at`; answers them in the order of the subscriptions. */
  enqueueSubscribers: (
    subscriptionIds: readonly string[],
    payload: SubscriberPayload,
    at: number
  ) => Promise<SubscriberNotification[]>;
  /** Each subscription's newest notification that finished or has failed an attempt and waits to retry, by subscription id. */
  lastSends: (
    subscriptionIds: readonly string[]
  ) => Promise<ReadonlyMap<string, SubscriberNotification>>;
  /** Each channel's newest notification, by channel id. */
  latest: () => Promise<ReadonlyMap<string, Notification>>;
  /** When the earliest notification that may go is due (the oldest pending one of each channel), or nothing when none is pending. */
  nextDueAt: () => Promise<number | undefined>;
  /** Deletes the lane's finished notifications past its newest `keep` finished ones; answers how many went. Pending ones stay. The lane is a channel or a subscription id. */
  prune: (laneId: string, keep: number) => Promise<number>;
  /** The channel's newest notifications, pending ones included, newest first. */
  recent: (channelId: string, limit: number) => Promise<Notification[]>;
  /** Stores a finished notification; answers it with its id. */
  record: (finished: FinishedNotification) => Promise<Notification>;
  /** Stores what an attempt left; answers whether the notification still existed (its channel may have been deleted meanwhile). */
  settle: (id: string, settlement: NotificationSettlement) => Promise<boolean>;
}

/** Thrown by a read when a stored notification no longer fits its schema; the message names the notification, never the text. */
export class NotificationShapeError extends Error {
  readonly notificationId: string;
  constructor(id: string) {
    super(`the stored notification ${id} does not fit its schema`);
    this.name = "NotificationShapeError";
    this.notificationId = id;
  }
}

/** A notification row as the driver answers it. */
interface NotificationRow {
  attempts: number;
  channel_id: string | null;
  failure: string | null;
  finished_at: number | null;
  id: string;
  kind: string;
  next_attempt_at: number | null;
  payload: string;
  queued_at: number;
  reason: number | null;
  status: string;
  subscription_id: string | null;
}

/** What the failure column holds beside the reason code. */
const failureSchema = z.object({
  error: z.string().optional(),
  params: reasonParamsSchema,
});

/** Ids are UUIDv7 text generated here, which a webhook receiver sees as `webhook-id`; `newId` is a parameter so a test can fix them. */
export function notificationsRepository(
  executor: Executor,
  newId: () => string = () => Bun.randomUUIDv7()
): NotificationsRepository {
  const { notifications } = executor.tables;
  const column = (name: string) => sql.identifier(name);
  /** A column of the same table under the alias `other`, for the subqueries that compare two rows. */
  const other = (name: string) =>
    sql`${sql.identifier("other")}.${sql.identifier(name)}`;
  const columns = sql`${notifications.id} AS id, ${notifications.channelId} AS channel_id, ${notifications.subscriptionId} AS subscription_id, ${notifications.kind} AS kind, ${notifications.payload} AS payload, ${notifications.status} AS status, ${notifications.attempts} AS attempts, ${notifications.queuedAt} AS queued_at, ${notifications.nextAttemptAt} AS next_attempt_at, ${notifications.finishedAt} AS finished_at, ${notifications.reason} AS reason, ${notifications.failure} AS failure`;
  /** The same lane as this row: its channel or its subscription. */
  const sameLane = sql`(${other("channel_id")} = ${notifications.channelId} OR ${other("subscription_id")} = ${notifications.subscriptionId})`;
  /** A pending notification of the same lane queued before this one. */
  const olderPending = sql`SELECT 1 FROM ${notifications} AS ${sql.identifier("other")} WHERE ${sameLane} AND ${other("status")} = ${"pending"} AND (${other("queued_at")} < ${notifications.queuedAt} OR (${other("queued_at")} = ${notifications.queuedAt} AND ${other("id")} < ${notifications.id}))`;
  /** Newest first, in queue order. */
  const newest = sql`ORDER BY ${notifications.queuedAt} DESC, ${notifications.id} DESC`;
  const read = async (query: ReturnType<typeof sql>) =>
    (await executor.rows<NotificationRow>(query)).map(notificationOf);
  /** A read of a channel's rows alone, which are never a subscriber's. */
  const readChannel = async (query: ReturnType<typeof sql>) =>
    (await read(query)).flatMap((row) =>
      row.kind === "subscriber" ? [] : [row]
    );

  const insert = (row: QueuedNotification) =>
    sql`(${row.id}, ${row.kind === "subscriber" ? null : row.channelId}, ${row.kind === "subscriber" ? row.subscriptionId : null}, ${row.kind}, ${JSON.stringify(row.payload)}, ${row.status}, ${row.attempts}, ${row.queuedAt}, ${row.nextAttemptAt ?? null}, ${row.finishedAt ?? null}, ${row.failure ? reasons[row.failure.reason] : null}, ${failureText(row.failure)})`;
  const insertColumns = sql`(${column("id")}, ${column("channel_id")}, ${column("subscription_id")}, ${column("kind")}, ${column("payload")}, ${column("status")}, ${column("attempts")}, ${column("queued_at")}, ${column("next_attempt_at")}, ${column("finished_at")}, ${column("reason")}, ${column("failure")})`;
  /** Writes the rows a few hundred to a statement, under both backends' limit on parameters. */
  const insertAll = async (rows: readonly QueuedNotification[]) => {
    for (let at = 0; at < rows.length; at += rowsPerInsert) {
      // biome-ignore lint/performance/noAwaitInLoops: one statement after the other, in queue order
      await executor.run(
        sql`INSERT INTO ${notifications} ${insertColumns} VALUES ${sql.join(
          rows.slice(at, at + rowsPerInsert).map(insert),
          sql`, `
        )}`
      );
    }
  };

  return {
    drop: async (id) => {
      await executor.run(
        sql`DELETE FROM ${notifications} WHERE ${notifications.id} = ${id}`
      );
    },
    due: (now, limit, busyLanes) => {
      if (limit <= 0) {
        return Promise.resolve([]);
      }
      const free =
        busyLanes.length === 0
          ? sql``
          : sql` AND COALESCE(${notifications.channelId}, ${notifications.subscriptionId}) NOT IN (${sql.join(
              busyLanes.map((id) => sql`${id}`),
              sql`, `
            )})`;
      // A channel's due notifications go before a subscriber's, so the operator's alerts never wait behind a page's subscribers.
      // Only a lane's oldest pending notification may go: its newer ones wait behind it.
      return read(
        sql`SELECT ${columns} FROM ${notifications} WHERE ${notifications.status} = ${"pending"} AND ${notifications.nextAttemptAt} <= ${now}${free} AND NOT EXISTS (${olderPending}) ORDER BY CASE WHEN ${notifications.channelId} IS NULL THEN 1 ELSE 0 END, ${notifications.nextAttemptAt}, ${notifications.queuedAt}, ${notifications.id} LIMIT ${limit}`
      );
    },
    enqueue: async (channelIds, kind, payload, at) => {
      const queued: Notification[] = channelIds.map((channelId) => ({
        attempts: 0,
        channelId,
        failure: undefined,
        finishedAt: undefined,
        id: newId(),
        kind,
        nextAttemptAt: at,
        payload,
        queuedAt: at,
        status: "pending",
      }));
      await insertAll(queued);
      return queued;
    },
    enqueueSubscribers: async (subscriptionIds, payload, at) => {
      const queued: SubscriberNotification[] = subscriptionIds.map(
        (subscriptionId) => ({
          attempts: 0,
          failure: undefined,
          finishedAt: undefined,
          id: newId(),
          kind: "subscriber",
          nextAttemptAt: at,
          payload,
          queuedAt: at,
          status: "pending",
          subscriptionId,
        })
      );
      await insertAll(queued);
      return queued;
    },
    lastSends: async (subscriptionIds) => {
      const last = new Map<string, SubscriberNotification>();
      if (subscriptionIds.length > 0) {
        // ponytail: one parameter per subscription, so a page past 65,535 subscribers fails its list; read them by page if one ever grows so.
        const rows = await read(
          sql`SELECT ${columns} FROM ${notifications} WHERE ${inArray(notifications.subscriptionId, [...subscriptionIds])} AND (${notifications.status} <> ${"pending"} OR ${notifications.failure} IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM ${notifications} AS ${sql.identifier("other")} WHERE ${other("subscription_id")} = ${notifications.subscriptionId} AND (${other("status")} <> ${"pending"} OR ${other("failure")} IS NOT NULL) AND (${other("queued_at")} > ${notifications.queuedAt} OR (${other("queued_at")} = ${notifications.queuedAt} AND ${other("id")} > ${notifications.id})))`
        );
        for (const row of rows) {
          if (row.kind === "subscriber") {
            last.set(row.subscriptionId, row);
          }
        }
      }
      return last;
    },
    latest: async () => {
      const rows = await readChannel(
        sql`SELECT ${columns} FROM ${notifications} WHERE ${notifications.channelId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${notifications} AS ${sql.identifier("other")} WHERE ${other("channel_id")} = ${notifications.channelId} AND (${other("queued_at")} > ${notifications.queuedAt} OR (${other("queued_at")} = ${notifications.queuedAt} AND ${other("id")} > ${notifications.id})))`
      );
      return new Map(rows.map((row) => [row.channelId, row]));
    },
    nextDueAt: async () => {
      const [row] = await executor.rows<{ due: number | null }>(
        sql`SELECT MIN(${notifications.nextAttemptAt}) AS due FROM ${notifications} WHERE ${notifications.status} = ${"pending"} AND NOT EXISTS (${olderPending})`
      );
      return row?.due === null || row?.due === undefined
        ? undefined
        : Number(row.due);
    },
    prune: (laneId, keep) => {
      const inLane = sql`(${notifications.channelId} = ${laneId} OR ${notifications.subscriptionId} = ${laneId})`;
      return executor.run(
        sql`DELETE FROM ${notifications} WHERE ${inLane} AND ${notifications.status} <> ${"pending"} AND ${notifications.id} NOT IN (SELECT ${sql.identifier("id")} FROM (SELECT ${notifications.id} AS id FROM ${notifications} WHERE ${inLane} AND ${notifications.status} <> ${"pending"} ${newest} LIMIT ${keep}) AS ${sql.identifier("kept")})`
      );
    },
    recent: (channelId, limit) =>
      readChannel(
        sql`SELECT ${columns} FROM ${notifications} WHERE ${notifications.channelId} = ${channelId} ${newest} LIMIT ${limit}`
      ),
    record: async ({ channelId, id, kind, payload, queuedAt, settlement }) => {
      const recorded: Notification = {
        attempts: settlement.attempts,
        channelId,
        failure:
          settlement.status === "failed" ? settlement.failure : undefined,
        finishedAt: settlement.at,
        id: id ?? newId(),
        kind,
        nextAttemptAt: undefined,
        payload,
        queuedAt,
        status: settlement.status,
      };
      await executor.run(
        sql`INSERT INTO ${notifications} ${insertColumns} VALUES ${insert(recorded)}`
      );
      return recorded;
    },
    settle: async (id, settlement) => {
      const failure =
        settlement.status === "sent" ? undefined : settlement.failure;
      const finishedAt = settlement.status === "pending" ? null : settlement.at;
      const nextAttemptAt =
        settlement.status === "pending" ? settlement.nextAttemptAt : null;
      const changed = await executor.run(
        sql`UPDATE ${notifications} SET ${column("status")} = ${settlement.status}, ${column("attempts")} = ${settlement.attempts}, ${column("next_attempt_at")} = ${nextAttemptAt}, ${column("finished_at")} = ${finishedAt}, ${column("reason")} = ${failure ? reasons[failure.reason] : null}, ${column("failure")} = ${failureText(failure)} WHERE ${notifications.id} = ${id}`
      );
      return changed > 0;
    },
  };
}

function failureText(failure: SendFailure | undefined): string | null {
  return failure
    ? JSON.stringify({ error: failure.error, params: failure.params })
    : null;
}

function notificationOf(row: NotificationRow): QueuedNotification {
  const kind = kindSchema.safeParse(row.kind);
  const status = statusSchema.safeParse(row.status);
  const failure = failureOf(row);
  if (!(kind.success && status.success) || failure === false) {
    throw new NotificationShapeError(row.id);
  }
  const common = {
    attempts: row.attempts,
    failure,
    finishedAt: row.finished_at ?? undefined,
    id: row.id,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    queuedAt: row.queued_at,
    status: status.data,
  };
  if (kind.data === "subscriber") {
    const payload = subscriberPayloadSchema.safeParse(parseJson(row.payload));
    if (!(payload.success && row.subscription_id !== null)) {
      throw new NotificationShapeError(row.id);
    }
    return {
      ...common,
      kind: kind.data,
      payload: payload.data,
      subscriptionId: row.subscription_id,
    };
  }
  const payload = notificationPayloadSchema.safeParse(parseJson(row.payload));
  if (!(payload.success && row.channel_id !== null)) {
    throw new NotificationShapeError(row.id);
  }
  return {
    ...common,
    channelId: row.channel_id,
    kind: kind.data,
    payload: payload.data,
  };
}

/** The stored failure, nothing when there is none, or false when it does not fit. */
function failureOf(row: NotificationRow): SendFailure | undefined | false {
  if (row.reason === null) {
    return row.failure === null ? undefined : false;
  }
  const reason = reasonName(row.reason);
  const stored = failureSchema.safeParse(parseJson(row.failure ?? ""));
  if (!(reason && stored.success)) {
    return false;
  }
  return { error: stored.data.error, params: stored.data.params, reason };
}

const kindSchema = z.enum(notificationKinds);
const statusSchema = z.enum(notificationStatuses);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
