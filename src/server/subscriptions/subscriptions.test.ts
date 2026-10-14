import { afterEach, describe, expect, test } from "bun:test";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { decrypt } from "@/server/boot/installkey.ts";
import type { HostLookup } from "@/server/notify/destination.ts";
import { d0, type PagesScratch, scratchPages } from "@/server/pages/fixture.ts";
import { createPage, savePage } from "@/server/pages/pages.ts";
import { runSql } from "@/server/storage/fixture.ts";
import type { SendFailure } from "@/shared/schemas/notification.ts";
import {
  defaultCustomization,
  type SubscriptionChannel,
} from "@/shared/schemas/page.ts";
import {
  confirmationCooldownMs,
  confirmationLifetimeMs,
  type SubscribeInput,
} from "@/shared/schemas/subscription.ts";
import {
  actionResponse,
  confirmSubscription,
  createSignUpLimiter,
  listSubscribers,
  offeredChannels,
  readSubscription,
  removeSubscriber,
  type SignUpLimiter,
  type SignUpOptions,
  signUpPeriodMs,
  signUpsPerClient,
  subscribe,
  subscriptionFrame,
  subscriptionView,
  unsubscribe,
} from "./subscriptions.ts";

const key = await scratchInstallKey();

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const now = d0 + 5 * 86_400_000;

/** The value, or a failed test when there is none. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

async function page(
  s: PagesScratch,
  slug: string,
  subscriptions: readonly SubscriptionChannel[] = ["email", "webhook"]
): Promise<string> {
  const created = await createPage(s.storage, {
    locale: "ar",
    slug,
    title: slug,
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const saved = await savePage(s.storage, created.page.id, {
    customDomain: undefined,
    customization: {
      ...defaultCustomization,
      subscriptions: [...subscriptions],
    },
    isDefault: created.page.isDefault,
    published: true,
    layout: [],
    locale: "ar",
    slug,
    title: { ar: slug },
  });
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  return created.page.id;
}

async function emailChannel(s: PagesScratch): Promise<void> {
  await s.storage.channels.create({
    appliesToNew: false,
    config: {
      from: "status@example.test",
      host: "smtp.example.test",
      port: "587",
      security: "starttls",
      to: "ops@example.test",
    },
    locale: undefined,
    name: "mail",
    type: "email",
  });
}

async function world() {
  scratch = await scratchPages(d0);
  scratch.at(now);
  const main = await page(scratch, "main");
  return { main, s: scratch };
}

const internet: HostLookup = () => Promise.resolve(["93.184.216.34"]);

/** The options of one sign-up, recording the confirmations it asks for. */
function options(
  overrides: Partial<SignUpOptions> = {}
): SignUpOptions & { readonly confirmations: string[] } {
  const confirmations: string[] = [];
  return {
    client: "203.0.113.5",
    confirm: (id) => {
      confirmations.push(id);
      return Promise.resolve(true);
    },
    confirmations,
    limiter: createSignUpLimiter(Number.POSITIVE_INFINITY),
    lookup: internet,
    now,
    ...overrides,
  };
}

const email = (
  pageId: string,
  address = "reader@example.test"
): SubscribeInput => ({
  address,
  channel: "email",
  locale: "en",
  pageId,
});

const webhook = (
  pageId: string,
  address = "https://hooks.example.com/raaqeb?key=secret"
): SubscribeInput => ({ address, channel: "webhook", locale: "ar", pageId });

describe("signing up", () => {
  test("an email sign-up stores a pending subscription in the locale of the address it came from, and queues its confirmation", async () => {
    const { main, s } = await world();
    await emailChannel(s);
    const run = options();
    expect(await subscribe(s.storage, key, email(main), run)).toEqual({
      ok: true,
    });
    const [stored] = await s.storage.subscriptions.list(main);
    expect(stored).toMatchObject({
      address: "reader@example.test",
      channel: "email",
      credentials: undefined,
      locale: "en",
      requestedAt: now,
      status: "pending",
    });
    expect(run.confirmations).toEqual([defined(stored).id]);
  });

  test("the same address again answers the same, with no second confirmation until the last is ten minutes old", async () => {
    const { main, s } = await world();
    await emailChannel(s);
    const first = options();
    await subscribe(s.storage, key, email(main), first);
    const soon = options({ now: now + confirmationCooldownMs - 1 });
    expect(await subscribe(s.storage, key, email(main), soon)).toEqual({
      ok: true,
    });
    expect(soon.confirmations).toEqual([]);
    const later = options({ now: now + confirmationCooldownMs });
    expect(await subscribe(s.storage, key, email(main), later)).toEqual({
      ok: true,
    });
    expect(later.confirmations).toEqual(first.confirmations);
    expect(await s.storage.subscriptions.list(main)).toHaveLength(1);
  });

  test("a confirmed address answers the same and gets nothing", async () => {
    const { main, s } = await world();
    await emailChannel(s);
    await subscribe(s.storage, key, email(main), options());
    const [stored] = await s.storage.subscriptions.list(main);
    await s.storage.subscriptions.confirm(defined(stored).token, now, now - 1);
    const again = options({ now: now + confirmationLifetimeMs });
    expect(await subscribe(s.storage, key, email(main), again)).toEqual({
      ok: true,
    });
    expect(again.confirmations).toEqual([]);
  });

  test("email is not offered without an email channel, or on a page that hides it, and a webhook not on a page that hides it", async () => {
    const { main, s } = await world();
    expect(await subscribe(s.storage, key, email(main), options())).toEqual({
      ok: false,
      reason: "not_offered",
    });
    await emailChannel(s);
    const hooksOnly = await page(s, "hooks", ["webhook"]);
    const mailOnly = await page(s, "mail", ["email"]);
    expect(
      await subscribe(s.storage, key, email(hooksOnly), options())
    ).toEqual({ ok: false, reason: "not_offered" });
    expect(
      await subscribe(s.storage, key, webhook(mailOnly), options())
    ).toEqual({ ok: false, reason: "not_offered" });
    expect(await s.storage.subscriptions.list(hooksOnly)).toEqual([]);
    expect(await s.storage.subscriptions.list(mailOnly)).toEqual([]);
  });

  test("an unpublished page takes no sign-up: it is not found and stores nothing, and no confirmation is asked for", async () => {
    const { main, s } = await world();
    await emailChannel(s);
    const stored = defined(await s.storage.pages.find(main));
    await s.storage.pages.save(main, { ...stored, published: false }, []);
    const run = options();
    for (const input of [email(main), webhook(main)]) {
      // biome-ignore lint/performance/noAwaitInLoops: one sign-up after the other
      expect(await subscribe(s.storage, key, input, run)).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
    expect(await s.storage.subscriptions.list(main)).toEqual([]);
    expect(run.confirmations).toEqual([]);
  });

  test("a page that does not exist is not found", async () => {
    const { s } = await world();
    await emailChannel(s);
    expect(
      await subscribe(s.storage, key, email("nothing"), options())
    ).toEqual({ ok: false, reason: "not_found" });
  });

  test("a webhook's URL is sealed with the install key and kept apart from the others by its SHA-256, never in clear", async () => {
    const { main, s } = await world();
    const url = "https://hooks.example.com/raaqeb?key=secret";
    expect(
      await subscribe(s.storage, key, webhook(main, url), options())
    ).toEqual({ ok: true });
    const [stored] = await s.storage.subscriptions.list(main);
    expect(stored?.address).toBe(
      new Bun.CryptoHasher("sha256").update(url).digest("hex")
    );
    expect(await decrypt(key, defined(defined(stored).credentials))).toBe(url);
    const rows = await runSql(s.location, "SELECT * FROM subscriptions");
    expect(JSON.stringify(rows)).not.toContain("hooks.example.com");
  });

  test("a webhook on a private network, or whose name does not resolve, is refused as unreachable and stores nothing", async () => {
    const { main, s } = await world();
    const lookups: HostLookup[] = [
      () => Promise.resolve(["10.0.0.4"]),
      () => Promise.reject(new Error("no such name")),
    ];
    for (const lookup of lookups) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: each is its own case
        await subscribe(s.storage, key, webhook(main), options({ lookup }))
      ).toEqual({ ok: false, reason: "unreachable" });
    }
    expect(await s.storage.subscriptions.list(main)).toEqual([]);
  });

  test("a client gets five sign-ups in ten minutes: the sixth is limited and stores nothing, another client is not, and the period's end frees it", async () => {
    const { main, s } = await world();
    await emailChannel(s);
    const limiter = createSignUpLimiter();
    const at = (client: string, offset: number, address: string) =>
      subscribe(
        s.storage,
        key,
        email(main, address),
        options({ client, limiter, now: now + offset })
      );
    for (let n = 0; n < signUpsPerClient; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the limiter counts in order
      expect(await at("203.0.113.5", n, `r${n}@example.test`)).toEqual({
        ok: true,
      });
    }
    expect(await at("203.0.113.5", 10, "late@example.test")).toEqual({
      ok: false,
      reason: "limited",
    });
    expect(
      (await s.storage.subscriptions.list(main)).map((each) => each.address)
    ).not.toContain("late@example.test");
    expect(await at("198.51.100.8", 10, "other@example.test")).toEqual({
      ok: true,
    });
    expect(
      await at("203.0.113.5", signUpPeriodMs, "later@example.test")
    ).toEqual({
      ok: true,
    });
  });

  test("addresses of one IPv6 /64 share one allowance, as one client", () => {
    const limiter = createSignUpLimiter(2, 1000);
    expect(limiter.take("2001:db8:1:2::1", 0)).toBe(true);
    expect(limiter.take("2001:db8:1:2:ffff::9", 1)).toBe(true);
    expect(limiter.take("2001:0db8:0001:0002:abcd::1", 2)).toBe(false);
    expect(limiter.take("2001:db8:1:3::1", 2)).toBe(true);
    expect(limiter.take("203.0.113.5", 2)).toBe(true);
  });

  test("an IPv4 address written in IPv6 counts as that IPv4 address, apart from any other and from ::1", () => {
    const limiter = createSignUpLimiter(1, 1000);
    expect(limiter.take("::ffff:10.0.0.1", 0)).toBe(true);
    expect(limiter.take("::ffff:10.0.0.2", 0)).toBe(true);
    expect(limiter.take("10.0.0.1", 0)).toBe(false);
    expect(limiter.take("::1", 0)).toBe(true);
  });

  test("the limiter counts sign-ups with no known client together", () => {
    const limiter: SignUpLimiter = createSignUpLimiter(2, 1000);
    expect(limiter.take(undefined, 0)).toBe(true);
    expect(limiter.take(undefined, 1)).toBe(true);
    expect(limiter.take(undefined, 2)).toBe(false);
    expect(limiter.take("a", 2)).toBe(true);
  });

  test("a confirmation that could not be queued, or a database that fails, answers unavailable", async () => {
    const { main, s } = await world();
    await emailChannel(s);
    expect(
      await subscribe(
        s.storage,
        key,
        email(main),
        options({ confirm: () => Promise.resolve(false) })
      )
    ).toEqual({ ok: false, reason: "unavailable" });
    await s.storage.close();
    expect(
      await subscribe(s.storage, key, email(main, "b@example.test"), options())
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the channels a page offers", () => {
  test("are those its customization shows, email only while an email channel exists", () => {
    const both = { customization: defaultCustomization };
    expect(offeredChannels(both, true)).toEqual(["email", "webhook"]);
    expect(offeredChannels(both, false)).toEqual(["webhook"]);
    expect(
      offeredChannels(
        { customization: { ...defaultCustomization, subscriptions: [] } },
        true
      )
    ).toEqual([]);
  });
});

describe("a subscription's own page", () => {
  async function signedUp(channel: SubscriptionChannel) {
    const { main, s } = await world();
    await emailChannel(s);
    await subscribe(
      s.storage,
      key,
      channel === "email" ? email(main) : webhook(main),
      options()
    );
    const [stored] = await s.storage.subscriptions.list(main);
    return { main, s, stored: defined(stored) };
  }

  test("shows an email subscription's address and a webhook's host alone", async () => {
    const mail = await signedUp("email");
    expect(
      await readSubscription(mail.s.storage, key, mail.stored.token, now)
    ).toEqual({
      ok: true,
      subscription: {
        address: "reader@example.test",
        channel: "email",
        state: "pending",
      },
    });
    await scratch?.cleanup();
    const hook = await signedUp("webhook");
    scratch = hook.s;
    expect(
      await readSubscription(hook.s.storage, key, hook.stored.token, now)
    ).toEqual({
      ok: true,
      subscription: {
        address: "hooks.example.com",
        channel: "webhook",
        state: "pending",
      },
    });
  });

  test("names the page and the locale the root renders it in", async () => {
    const { main, s, stored } = await signedUp("email");
    expect(await subscriptionFrame(s.storage, stored.token)).toEqual({
      locale: "en",
      pageId: main,
    });
    expect(await subscriptionFrame(s.storage, "nothing")).toBeUndefined();
  });

  test("a pending one whose link is past its lifetime is expired, and confirming it moves nothing", async () => {
    const { s, stored } = await signedUp("email");
    const late = now + confirmationLifetimeMs;
    expect(
      await readSubscription(s.storage, key, stored.token, late)
    ).toMatchObject({ subscription: { state: "expired" } });
    expect(await confirmSubscription(s.storage, stored.token, late)).toEqual({
      ok: true,
      state: "expired",
    });
    expect(await s.storage.subscriptions.find(stored.id)).toMatchObject({
      status: "pending",
    });
  });

  test("confirming moves a pending one to confirmed, once, and never an unsubscribed one", async () => {
    const { s, stored } = await signedUp("email");
    expect(await confirmSubscription(s.storage, stored.token, now + 1)).toEqual(
      { ok: true, state: "confirmed" }
    );
    expect(await confirmSubscription(s.storage, stored.token, now + 2)).toEqual(
      { ok: true, state: "confirmed" }
    );
    expect(await s.storage.subscriptions.find(stored.id)).toMatchObject({
      confirmedAt: now + 1,
    });
    expect(await unsubscribe(s.storage, stored.token, now + 3)).toEqual({
      ok: true,
      state: "unsubscribed",
    });
    expect(await confirmSubscription(s.storage, stored.token, now + 4)).toEqual(
      { ok: true, state: "unsubscribed" }
    );
  });

  test("still opens in its page's frame after the page is unpublished, so its subscriber can always unsubscribe", async () => {
    const { main, s, stored } = await signedUp("email");
    const shown = defined(await s.storage.pages.find(main));
    await s.storage.pages.save(main, { ...shown, published: false }, []);
    expect(await subscriptionView(s.storage, stored.token)).toMatchObject({
      locale: "en",
      pageId: main,
    });
    expect(await unsubscribe(s.storage, stored.token, now)).toEqual({
      ok: true,
      state: "unsubscribed",
    });
  });

  test("unsubscribing a pending one works too; an unknown token is not found everywhere", async () => {
    const { s, stored } = await signedUp("webhook");
    expect(await unsubscribe(s.storage, stored.token, now)).toEqual({
      ok: true,
      state: "unsubscribed",
    });
    expect(await readSubscription(s.storage, key, "nothing", now)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await confirmSubscription(s.storage, "nothing", now)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await unsubscribe(s.storage, "nothing", now)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("the admin's list of a page's subscribers", () => {
  test("lists them newest first, a webhook by its host, each with its state and how the last message to it went", async () => {
    const { main, s } = await world();
    await emailChannel(s);
    await subscribe(s.storage, key, email(main), options());
    await subscribe(
      s.storage,
      key,
      webhook(main),
      options({ now: now + 1000 })
    );
    const [hook, mail] = await s.storage.subscriptions.list(main);
    const [sent] = await s.storage.notifications.enqueueSubscribers(
      [defined(mail).id],
      {
        page: { id: main, name: "main", url: "https://status.raaqeb.test" },
        timestamp: new Date(now).toISOString(),
        type: "subscription.confirmation",
      },
      now
    );
    await s.storage.notifications.settle(defined(sent).id, {
      at: now + 50,
      attempts: 1,
      status: "sent",
    });
    const listed = await listSubscribers(
      s.storage,
      key,
      main,
      now + confirmationLifetimeMs
    );
    expect(listed).toEqual({
      list: {
        now: now + confirmationLifetimeMs,
        page: { id: main, title: { ar: "main" } },
        subscribers: [
          {
            address: "hooks.example.com",
            channel: "webhook",
            confirmedAt: undefined,
            createdAt: now + 1000,
            id: defined(hook).id,
            lastSend: undefined,
            locale: "ar",
            requestedAt: now + 1000,
            state: "pending",
          },
          {
            address: "reader@example.test",
            channel: "email",
            confirmedAt: undefined,
            createdAt: now,
            id: defined(mail).id,
            lastSend: { at: now + 50, failure: undefined, status: "sent" },
            locale: "en",
            requestedAt: now,
            state: "expired",
          },
        ],
      },
      ok: true,
    });
    expect(await listSubscribers(s.storage, key, "nothing", now)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("a confirmation that failed and waits to be retried shows as the last message, with why it failed", async () => {
    const { main, s } = await world();
    await subscribe(s.storage, key, webhook(main), options());
    const [hook] = await s.storage.subscriptions.list(main);
    const [queued] = await s.storage.notifications.enqueueSubscribers(
      [defined(hook).id],
      {
        page: { id: main, name: "main", url: "https://status.raaqeb.test" },
        timestamp: new Date(now).toISOString(),
        type: "subscription.confirmation",
      },
      now
    );
    const failure: SendFailure = {
      error: "Unable to connect",
      params: {
        host: "hooks.example.com",
        port: 443,
        reason: "connection_refused",
      },
      reason: "connection_refused",
    };
    await s.storage.notifications.settle(defined(queued).id, {
      attempts: 1,
      failure,
      nextAttemptAt: now + 30_000,
      status: "pending",
    });
    const listed = await listSubscribers(s.storage, key, main, now);
    expect(listed).toMatchObject({
      list: {
        subscribers: [{ lastSend: { at: now, failure, status: "pending" } }],
      },
      ok: true,
    });
  });

  test("removing one deletes it; another page's or an unknown one is not found", async () => {
    const { main, s } = await world();
    const other = await page(s, "other");
    await subscribe(s.storage, key, webhook(main), options());
    const [stored] = await s.storage.subscriptions.list(main);
    const { id } = defined(stored);
    expect(await removeSubscriber(s.storage, other, id)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await removeSubscriber(s.storage, main, id)).toEqual({ ok: true });
    expect(await removeSubscriber(s.storage, main, id)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await s.storage.subscriptions.list(main)).toEqual([]);
  });
});

describe("what a confirm or unsubscribe POST answers", () => {
  test("a 303 to the subscription's page, never cached", () => {
    const answer = actionResponse(
      { ok: true, state: "confirmed" },
      "e2e-pending-token-0001",
      false
    );
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(
      "/subscriptions/e2e-pending-token-0001"
    );
    expect(answer.headers.get("cache-control")).toBe("no-store");
  });

  test("an email client's one-click unsubscribe gets a plain 200 and no redirect", async () => {
    const answer = actionResponse(
      { ok: true, state: "unsubscribed" },
      "e2e-pending-token-0001",
      true
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("location")).toBeNull();
    expect(await answer.text()).toBe("Unsubscribed");
  });

  test("an unknown token is 404 Not Found and a database that did not answer 503 Service Unavailable, the HTTP reason phrases, one-click or not", async () => {
    for (const oneClick of [false, true]) {
      const unknown = actionResponse(
        { ok: false, reason: "not_found" },
        "x",
        oneClick
      );
      expect(unknown.status).toBe(404);
      // biome-ignore lint/performance/noAwaitInLoops: one answer at a time
      expect(await unknown.text()).toBe("Not Found");
      const unavailable = actionResponse(
        { ok: false, reason: "unavailable" },
        "x",
        oneClick
      );
      expect(unavailable.status).toBe(503);
      expect(await unavailable.text()).toBe("Service Unavailable");
    }
  });
});

describe("edges of signing up", () => {
  test("a client past its share is limited before any read, so a flood costs no query", async () => {
    const { main, s } = await world();
    const limiter = createSignUpLimiter(1);
    await subscribe(s.storage, key, webhook(main), options({ limiter }));
    await s.storage.close();
    expect(
      await subscribe(s.storage, key, webhook(main), options({ limiter }))
    ).toEqual({ ok: false, reason: "limited" });
  });

  test("a webhook refused as written, not https or on a private address, costs the client no sign-up", async () => {
    const { main, s } = await world();
    const limiter = createSignUpLimiter(1);
    for (const address of [
      "http://hooks.example.com/raaqeb",
      "https://10.0.0.4/raaqeb",
      "not a url",
    ]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: the limiter counts in order
        await subscribe(
          s.storage,
          key,
          webhook(main, address),
          options({ limiter })
        )
      ).toEqual({ ok: false, reason: "unreachable" });
    }
    expect(
      await subscribe(s.storage, key, webhook(main), options({ limiter }))
    ).toEqual({ ok: true });
  });

  test("an unsubscribed address that signs up again gets a new confirmation", async () => {
    const { main, s } = await world();
    const first = options();
    await subscribe(s.storage, key, webhook(main), first);
    const [stored] = await s.storage.subscriptions.list(main);
    await unsubscribe(s.storage, defined(stored).token, now);
    const again = options({ now: now + confirmationCooldownMs });
    await subscribe(s.storage, key, webhook(main), again);
    expect(again.confirmations).toEqual(first.confirmations);
    expect(
      await s.storage.subscriptions.find(defined(stored).id)
    ).toMatchObject({ status: "pending" });
  });

  test("a webhook the install key cannot open shows no host on its page", async () => {
    const { main, s } = await world();
    await subscribe(s.storage, key, webhook(main), options());
    const [stored] = await s.storage.subscriptions.list(main);
    const other = await scratchInstallKey();
    expect(
      await readSubscription(s.storage, other, defined(stored).token, now)
    ).toMatchObject({ subscription: { address: "" } });
  });
});
