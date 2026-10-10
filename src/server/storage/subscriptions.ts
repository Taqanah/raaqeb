/**
 * The subscriptions repository (CONTEXT.md "Subscription"): one row per subscriber of one status page through one
 * channel, unique by page, channel and address. The address is the email
 * address, or for a webhook the SHA-256 of its URL, while the URL itself is
 * sealed with the install key by the module that writes it. A sign-up
 * writes one statement whatever the row's state, so two at once never make
 * two rows. Rows never leave this file: every answer is a
 * `StoredSubscription`.
 */
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type Locale, localeSchema } from "@/shared/i18n/locale.ts";
import {
  type SubscriptionChannel,
  subscriptionChannels,
} from "@/shared/schemas/page.ts";
import {
  type SubscriptionStatus,
  subscriptionStatusSchema,
} from "@/shared/schemas/subscription.ts";
import type { Executor } from "./connection.ts";

/** A subscription as stored: the shared fields, its token and its sealed webhook URL. */
export interface StoredSubscription {
  /** The email address, or the SHA-256 of the webhook's URL. */
  readonly address: string;
  readonly channel: SubscriptionChannel;
  readonly confirmedAt: number | undefined;
  readonly createdAt: number;
  /** The webhook's URL sealed with the install key; nothing for email. */
  readonly credentials: string | undefined;
  readonly id: string;
  readonly locale: Locale;
  readonly pageId: string;
  /** When the last confirmation was sent. */
  readonly requestedAt: number;
  readonly status: SubscriptionStatus;
  readonly token: string;
}

/** A sign-up: a new subscription, or one the page already has asked to confirm again. */
export interface SubscriptionRequest {
  readonly address: string;
  readonly channel: SubscriptionChannel;
  readonly credentials: string | undefined;
  readonly locale: Locale;
  readonly pageId: string;
  /** A confirmation sent after this is too recent to send another. */
  readonly quietSince: number;
  readonly requestedAt: number;
}

export interface SubscriptionsRepository {
  byToken: (token: string) => Promise<StoredSubscription | undefined>;
  /** Confirms the pending subscription with this token while its link was sent after `sentAfter`; answers whether it moved. */
  confirm: (token: string, now: number, sentAfter: number) => Promise<boolean>;
  /** The confirmed subscriptions of these pages. */
  confirmed: (pageIds: readonly string[]) => Promise<StoredSubscription[]>;
  /** Deletes every pending subscription whose link was sent before `before`; answers how many went. */
  expire: (before: number) => Promise<number>;
  find: (id: string) => Promise<StoredSubscription | undefined>;
  /** The page's subscriptions, newest first. */
  list: (pageId: string) => Promise<StoredSubscription[]>;
  /** Deletes one of the page's subscriptions; answers whether it existed. */
  remove: (pageId: string, id: string) => Promise<boolean>;
  /**
   * Stores a new pending subscription, or moves the page's one for this
   * channel and address back to pending with a new confirmation time, its
   * language and its sealed URL, unless it is confirmed or its last
   * confirmation went after `quietSince`. Answers the subscription a
   * confirmation is due for, or nothing.
   */
  request: (
    request: SubscriptionRequest
  ) => Promise<StoredSubscription | undefined>;
  /** Unsubscribes the subscription with this token unless it already is; answers whether it moved. */
  unsubscribe: (token: string) => Promise<boolean>;
}

/** Thrown by a read when a stored subscription no longer fits its shape; the message names the subscription, never the text. */
export class SubscriptionShapeError extends Error {
  readonly subscriptionId: string;
  constructor(id: string) {
    super(`the stored subscription ${id} does not fit its schema`);
    this.name = "SubscriptionShapeError";
    this.subscriptionId = id;
  }
}

/** A row as the driver answers it. */
interface SubscriptionRow {
  address: string;
  channel: string;
  confirmed_at: number | null;
  created_at: number;
  credentials: string | null;
  id: string;
  locale: string;
  page_id: string;
  requested_at: number;
  status: string;
  token: string;
}

const channelSchema = z.enum(subscriptionChannels);

/** Ids are UUIDv7 and tokens 16 random bytes in base64url; both are parameters so a test can fix them. */
export function subscriptionsRepository(
  executor: Executor,
  newId: () => string = () => Bun.randomUUIDv7(),
  newToken: () => string = () =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
      "base64url"
    )
): SubscriptionsRepository {
  const { subscriptions } = executor.tables;
  const column = (name: string) => sql.identifier(name);
  const columns = sql`${subscriptions.id} AS id, ${subscriptions.pageId} AS page_id, ${subscriptions.channel} AS channel, ${subscriptions.address} AS address, ${subscriptions.credentials} AS credentials, ${subscriptions.locale} AS locale, ${subscriptions.token} AS token, ${subscriptions.status} AS status, ${subscriptions.requestedAt} AS requested_at, ${subscriptions.confirmedAt} AS confirmed_at, ${subscriptions.createdAt} AS created_at`;
  const read = async (query: ReturnType<typeof sql>) =>
    (await executor.rows<SubscriptionRow>(query)).map(subscriptionOf);
  const first = async (query: ReturnType<typeof sql>) => (await read(query))[0];

  return {
    byToken: (token) =>
      first(
        sql`SELECT ${columns} FROM ${subscriptions} WHERE ${subscriptions.token} = ${token}`
      ),
    confirm: async (token, now, sentAfter) =>
      (await executor.run(
        sql`UPDATE ${subscriptions} SET ${column("status")} = ${"confirmed"}, ${column("confirmed_at")} = ${now} WHERE ${subscriptions.token} = ${token} AND ${subscriptions.status} = ${"pending"} AND ${subscriptions.requestedAt} > ${sentAfter}`
      )) > 0,
    confirmed: (pageIds) =>
      pageIds.length === 0
        ? Promise.resolve([])
        : read(
            sql`SELECT ${columns} FROM ${subscriptions} WHERE ${subscriptions.status} = ${"confirmed"} AND ${inArray(subscriptions.pageId, [...pageIds])}`
          ),
    expire: (before) =>
      executor.run(
        sql`DELETE FROM ${subscriptions} WHERE ${subscriptions.status} = ${"pending"} AND ${subscriptions.requestedAt} < ${before}`
      ),
    find: (id) =>
      first(
        sql`SELECT ${columns} FROM ${subscriptions} WHERE ${subscriptions.id} = ${id}`
      ),
    list: (pageId) =>
      read(
        sql`SELECT ${columns} FROM ${subscriptions} WHERE ${subscriptions.pageId} = ${pageId} ORDER BY ${subscriptions.createdAt} DESC, ${subscriptions.id} DESC`
      ),
    remove: async (pageId, id) =>
      (await executor.run(
        sql`DELETE FROM ${subscriptions} WHERE ${subscriptions.id} = ${id} AND ${subscriptions.pageId} = ${pageId}`
      )) > 0,
    request: (request) => {
      const excluded = (name: string) => sql`excluded.${column(name)}`;
      // One statement whatever the row's state, so two sign-ups at once never make two rows.
      return first(
        sql`INSERT INTO ${subscriptions} (${column("id")}, ${column("page_id")}, ${column("channel")}, ${column("address")}, ${column("credentials")}, ${column("locale")}, ${column("token")}, ${column("status")}, ${column("requested_at")}, ${column("confirmed_at")}, ${column("created_at")}) VALUES (${newId()}, ${request.pageId}, ${request.channel}, ${request.address}, ${request.credentials ?? null}, ${request.locale}, ${newToken()}, ${"pending"}, ${request.requestedAt}, ${null}, ${request.requestedAt}) ON CONFLICT (${column("page_id")}, ${column("channel")}, ${column("address")}) DO UPDATE SET ${column("status")} = ${"pending"}, ${column("requested_at")} = ${excluded("requested_at")}, ${column("locale")} = ${excluded("locale")}, ${column("credentials")} = ${excluded("credentials")}, ${column("confirmed_at")} = ${null} WHERE ${subscriptions.status} <> ${"confirmed"} AND ${subscriptions.requestedAt} <= ${request.quietSince} RETURNING ${columns}`
      );
    },
    unsubscribe: async (token) =>
      (await executor.run(
        sql`UPDATE ${subscriptions} SET ${column("status")} = ${"unsubscribed"} WHERE ${subscriptions.token} = ${token} AND ${subscriptions.status} <> ${"unsubscribed"}`
      )) > 0,
  };
}

function subscriptionOf(row: SubscriptionRow): StoredSubscription {
  const channel = channelSchema.safeParse(row.channel);
  const status = subscriptionStatusSchema.safeParse(row.status);
  const locale = localeSchema.safeParse(row.locale);
  if (!(channel.success && status.success && locale.success)) {
    throw new SubscriptionShapeError(row.id);
  }
  return {
    address: row.address,
    channel: channel.data,
    confirmedAt:
      row.confirmed_at === null ? undefined : Number(row.confirmed_at),
    createdAt: Number(row.created_at),
    credentials: row.credentials ?? undefined,
    id: row.id,
    locale: locale.data,
    pageId: row.page_id,
    requestedAt: Number(row.requested_at),
    status: status.data,
    token: row.token,
  };
}
