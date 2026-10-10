/**
 * The public side of subscriptions: the
 * subscribe form's server function, and the read behind a subscription's
 * own page. No session: the sign-up is counted per client address, as the
 * entry resolved it behind the trusted proxies, five in ten minutes. Not a
 * route file (the leading dash); it imports nothing of the admin, so the
 * public page carries no session-checked server function.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import type { Subscribe } from "@/public/subscribe.tsx";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { readViewFrame } from "@/server/pages/views.ts";
import {
  createSignUpLimiter,
  readSubscription,
  subscribe,
  subscriptionFrame,
} from "@/server/subscriptions/subscriptions.ts";
import {
  type SubscribeResult,
  type SubscriptionView,
  subscribeInputSchema,
} from "@/shared/schemas/subscription.ts";
import type { ViewFrame } from "@/shared/schemas/views.ts";

/** Every sign-up of this process, counted per client. */
const signUps = createSignUpLimiter();

export const subscribeFn = createServerFn({ method: "POST" })
  .validator(subscribeInputSchema)
  .handler(({ context, data }): Promise<SubscribeResult> => {
    const { boot, scheduler, storage } = context;
    if (!storage) {
      return Promise.resolve({ ok: false, reason: "unavailable" });
    }
    const now = Date.now();
    return subscribe(storage, boot.installKey, data, {
      client:
        new Headers(getRequestHeaders()).get(clientAddressHeader) ?? undefined,
      confirm: (id) =>
        scheduler
          ? scheduler.subscribers.confirm(id, now)
          : Promise.resolve(false),
      limiter: signUps,
      now,
    });
  });

/** What a subscription's own page shows: the page's frame and where the subscription stands; nothing for a token no subscription has. */
export interface SubscriptionPageData {
  readonly frame: ViewFrame;
  readonly subscription: SubscriptionView;
}

export const readSubscriptionPageFn = createServerFn({ method: "GET" })
  .validator(z.object({ token: z.string() }))
  .handler(
    async ({ context, data }): Promise<SubscriptionPageData | undefined> => {
      const { boot, storage } = context;
      if (!storage) {
        throw new Error("the subscription could not be read");
      }
      const [read, place] = await Promise.all([
        readSubscription(storage, boot.installKey, data.token, Date.now()),
        subscriptionFrame(storage, data.token),
      ]);
      if (!read.ok && read.reason === "not_found") {
        return;
      }
      const frame = place
        ? await readViewFrame(storage, place.pageId)
        : undefined;
      if (!(read.ok && frame?.ok)) {
        throw new Error("the subscription could not be read");
      }
      return { frame: frame.document, subscription: read.subscription };
    }
  );

/** The subscribe form's post, as the overview routes hand it to the form. */
export const subscribeByForm: Subscribe = (input) =>
  subscribeFn({ data: input });
