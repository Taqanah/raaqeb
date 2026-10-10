/**
 * The subscriptions module (CONTEXT.md "Subscriber", "Subscription"): the sign-up behind the subscribe form, the
 * subscription's own page with its confirm and unsubscribe, and the admin's
 * list of a page's subscribers with remove.
 *
 * A sign-up answers the same whether the address was new, pending or
 * already confirmed, so the form never tells who is subscribed: a new or
 * unsubscribed address becomes pending and gets its confirmation, a pending
 * one gets another no sooner than ten minutes after the last, a confirmed
 * one gets nothing. Each client may sign up five times in ten minutes. A
 * webhook's URL must be https on the public internet; it is sealed with the
 * install key and kept apart from the others by its SHA-256. A link that is
 * 48 hours old no longer confirms, and the nightly job deletes it. Results
 * never throw.
 */

import { decrypt, encrypt, type InstallKey } from "@/server/boot/installkey.ts";
import { clientNetwork } from "@/server/boot/proxies.ts";
import {
  type HostLookup,
  lookupHost,
  webhookReachable,
} from "@/server/notify/destination.ts";
import { canonicalPaths } from "@/server/pages/public.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { StoredSubscription } from "@/server/storage/subscriptions.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { PublicView } from "@/shared/schemas/overview.ts";
import type { StatusPage, SubscriptionChannel } from "@/shared/schemas/page.ts";
import {
  confirmationCooldownMs,
  confirmationLifetimeMs,
  type SubscribeInput,
  type SubscribeResult,
  type Subscriber,
  type SubscriberListResult,
  type SubscriberRemoveResult,
  type SubscriptionActionResult,
  type SubscriptionView,
  type SubscriptionViewResult,
  subscriptionPath,
} from "@/shared/schemas/subscription.ts";

export type SubscriptionStorage = Pick<
  Storage,
  "channels" | "notifications" | "pages" | "settings" | "subscriptions"
>;

/** Sign-ups a client may make in one period, and the period. */
export const signUpsPerClient = 5;
export const signUpPeriodMs = 10 * 60 * 1000;

/** Counts each client's sign-ups in memory, one process; a restart forgets them. */
export interface SignUpLimiter {
  /** Takes one sign-up for the client at `now`; false once it has had its share of the period. A request with no known client shares one allowance. */
  readonly take: (client: string | undefined, now: number) => boolean;
}

export function createSignUpLimiter(
  limit: number = signUpsPerClient,
  periodMs: number = signUpPeriodMs
): SignUpLimiter {
  /** Each client's sign-ups inside the period, oldest first. */
  const taken = new Map<string, number[]>();
  /** When the map last dropped the clients quiet for a period. */
  let swept = 0;
  return {
    take: (client, now) => {
      // One host holds a whole IPv6 /64, so the /64 is the client.
      const key = client === undefined ? "" : clientNetwork(client);
      const recent = (taken.get(key) ?? []).filter((at) => now - at < periodMs);
      if (recent.length >= limit) {
        taken.set(key, recent);
        return false;
      }
      taken.set(key, [...recent, now]);
      // Once a period, the clients quiet for a whole one are forgotten, so the map holds the clients of about two periods and a sign-up rarely walks it.
      if (now - swept >= periodMs) {
        swept = now;
        for (const [other, times] of taken) {
          if (times.every((at) => now - at >= periodMs)) {
            taken.delete(other);
          }
        }
      }
      return true;
    },
  };
}

/** The channels a page offers: those its customization shows, email only while an email channel exists. */
export function offeredChannels(
  page: Pick<StatusPage, "customization">,
  emailChannel: boolean
): SubscriptionChannel[] {
  return page.customization.subscriptions.filter(
    (channel) => channel !== "email" || emailChannel
  );
}

export interface SignUpOptions {
  /** The client's address behind the trusted proxies, which the limiter counts by. */
  readonly client: string | undefined;
  /** Queues the confirmation of the subscription; false when it could not be queued. */
  readonly confirm: (subscriptionId: string) => Promise<boolean>;
  readonly limiter: SignUpLimiter;
  /** Resolves a webhook's host; the system's resolver when absent. */
  readonly lookup?: HostLookup;
  readonly now: number;
}

const unavailable = { ok: false, reason: "unavailable" } as const;
const notFound = { ok: false, reason: "not_found" } as const;

/** A visitor's sign-up on a page, in the locale of the address they were on. */
export async function subscribe(
  storage: SubscriptionStorage,
  key: InstallKey,
  input: SubscribeInput,
  options: SignUpOptions
): Promise<SubscribeResult> {
  // Counted before any read, so a flood from one client costs no query.
  if (!options.limiter.take(options.client, options.now)) {
    return { ok: false, reason: "limited" };
  }
  try {
    const [page, channels] = await Promise.all([
      storage.pages.find(input.pageId),
      storage.channels.list(),
    ]);
    // An unpublished page takes no sign-up.
    if (!page?.published) {
      return notFound;
    }
    const offered = offeredChannels(
      page,
      channels.some((channel) => channel.type === "email")
    );
    if (!offered.includes(input.channel)) {
      return { ok: false, reason: "not_offered" };
    }
    const webhook = input.channel === "webhook";
    if (
      webhook &&
      !(await webhookReachable(input.address, options.lookup ?? lookupHost))
    ) {
      return { ok: false, reason: "unreachable" };
    }
    const due = await storage.subscriptions.request({
      address: webhook
        ? new Bun.CryptoHasher("sha256").update(input.address).digest("hex")
        : input.address,
      channel: input.channel,
      credentials: webhook ? await encrypt(key, input.address) : undefined,
      locale: input.locale,
      pageId: page.id,
      quietSince: options.now - confirmationCooldownMs,
      requestedAt: options.now,
    });
    // The same answer whether the address was new, pending or confirmed: the form never tells who is subscribed.
    if (due && !(await options.confirm(due.id))) {
      return unavailable;
    }
    return { ok: true };
  } catch {
    return unavailable;
  }
}

/** The page's id and locale for a subscription's own page, which the root renders it in; nothing for an unknown token. */
export async function subscriptionFrame(
  storage: SubscriptionStorage,
  token: string
): Promise<{ readonly locale: Locale; readonly pageId: string } | undefined> {
  try {
    const subscription = await storage.subscriptions.byToken(token);
    return subscription
      ? { locale: subscription.locale, pageId: subscription.pageId }
      : undefined;
  } catch {
    // A database that does not answer shows no subscription, and the page is the router's not-found.
  }
}

/** The page and locale a subscription's own page renders in: the subscription language, at the page's own addresses; nothing for an unknown token. The root reads it for the document's language. */
export async function subscriptionView(
  storage: SubscriptionStorage,
  token: string
): Promise<PublicView | undefined> {
  const place = await subscriptionFrame(storage, token);
  const page = place ? await storage.pages.find(place.pageId) : undefined;
  if (!(place && page)) {
    return;
  }
  return {
    locale: place.locale,
    pageId: page.id,
    paths: canonicalPaths(page, await readPublicAddress(storage)),
  };
}

/** A stored subscription's state at `now`: a pending one whose link is past its lifetime is expired. */
function stateOf(
  subscription: StoredSubscription,
  now: number
): SubscriptionView["state"] {
  return subscription.status === "pending" &&
    now - subscription.requestedAt >= confirmationLifetimeMs
    ? "expired"
    : subscription.status;
}

/** The address a subscriber sees: an email address, or a webhook's host alone; nothing when the key cannot open the URL. */
async function shownAddress(
  key: InstallKey,
  subscription: StoredSubscription
): Promise<string> {
  if (subscription.channel === "email") {
    return subscription.address;
  }
  const url =
    subscription.credentials === undefined
      ? undefined
      : await decrypt(key, subscription.credentials);
  return url !== undefined && URL.canParse(url) ? new URL(url).host : "";
}

/** What the subscription with this token is and where it stands. */
export async function readSubscription(
  storage: SubscriptionStorage,
  key: InstallKey,
  token: string,
  now: number
): Promise<SubscriptionViewResult> {
  try {
    const subscription = await storage.subscriptions.byToken(token);
    if (!subscription) {
      return notFound;
    }
    return {
      ok: true,
      subscription: {
        address: await shownAddress(key, subscription),
        channel: subscription.channel,
        state: stateOf(subscription, now),
      },
    };
  } catch {
    return unavailable;
  }
}

/** Confirms a pending subscription whose link is younger than its lifetime; answers the state after. */
export async function confirmSubscription(
  storage: SubscriptionStorage,
  token: string,
  now: number
): Promise<SubscriptionActionResult> {
  try {
    await storage.subscriptions.confirm(
      token,
      now,
      now - confirmationLifetimeMs
    );
    return await stateAfter(storage, token, now);
  } catch {
    return unavailable;
  }
}

/** Unsubscribes; answers the state after. */
export async function unsubscribe(
  storage: SubscriptionStorage,
  token: string,
  now: number
): Promise<SubscriptionActionResult> {
  try {
    await storage.subscriptions.unsubscribe(token);
    return await stateAfter(storage, token, now);
  } catch {
    return unavailable;
  }
}

/** The state of the subscription with this token after an action, or not found. */
async function stateAfter(
  storage: SubscriptionStorage,
  token: string,
  now: number
): Promise<SubscriptionActionResult> {
  const subscription = await storage.subscriptions.byToken(token);
  return subscription
    ? { ok: true, state: stateOf(subscription, now) }
    : notFound;
}

/** The page's subscribers for the admin, newest first, each with how the last message to it went. */
export async function listSubscribers(
  storage: SubscriptionStorage,
  key: InstallKey,
  pageId: string,
  now: number
): Promise<SubscriberListResult> {
  try {
    const page = await storage.pages.find(pageId);
    if (!page) {
      return notFound;
    }
    const stored = await storage.subscriptions.list(pageId);
    const last = await storage.notifications.lastSends(
      stored.map((each) => each.id)
    );
    const subscribers: Subscriber[] = await Promise.all(
      stored.map(async (each) => {
        const send = last.get(each.id);
        return {
          address: await shownAddress(key, each),
          channel: each.channel,
          confirmedAt: each.confirmedAt,
          createdAt: each.createdAt,
          id: each.id,
          lastSend: send && {
            at: send.finishedAt ?? send.queuedAt,
            failure: send.failure,
            status: send.status,
          },
          locale: each.locale,
          requestedAt: each.requestedAt,
          state: stateOf(each, now),
        };
      })
    );
    return {
      list: { now, page: { id: page.id, title: page.title }, subscribers },
      ok: true,
    };
  } catch {
    return unavailable;
  }
}

/** The operator removes a subscription: it is deleted with its queued messages. */
export async function removeSubscriber(
  storage: SubscriptionStorage,
  pageId: string,
  id: string
): Promise<SubscriberRemoveResult> {
  try {
    return (await storage.subscriptions.remove(pageId, id))
      ? { ok: true }
      : notFound;
  } catch {
    return unavailable;
  }
}

/**
 * What a confirm or unsubscribe POST answers: a 303 to the subscription's
 * page, which says where it stands; an email client's one-click
 * unsubscribe (RFC 8058) gets a plain 200, since it follows no redirect.
 * An unknown token is 404, a database that did not answer 503; neither is
 * cached.
 */
export function actionResponse(
  result: SubscriptionActionResult,
  token: string,
  oneClick: boolean
): Response {
  const plain = (status: number, text: string) =>
    new Response(text, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
      status,
    });
  if (!result.ok) {
    return result.reason === "not_found"
      ? plain(404, "Not Found")
      : plain(503, "Service Unavailable");
  }
  if (oneClick) {
    return plain(200, "Unsubscribed");
  }
  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      location: subscriptionPath(token),
    },
    status: 303,
  });
}
