import { describe, expect, test } from "bun:test";
import type { SubscriptionChannel } from "@/shared/schemas/page.ts";
import { render } from "./fixture.tsx";
import { SubscribeForm } from "./subscribe.tsx";

const feed = "https://status.example.test/en/feed.atom";

/** What the card writes for a browser without JavaScript. */
const noscriptPart = /<noscript>(.*?)<\/noscript>/s;

/** The page offers no channel the form could post, so it never posts. */
const never = () => Promise.resolve({ ok: false, reason: "invalid" } as const);

/** The subscribe card the server writes for a page offering these channels, seen in English. */
function card(channels: readonly SubscriptionChannel[]): string {
  return render(
    "en",
    <SubscribeForm
      channels={channels}
      feed={feed}
      locale="en"
      pageId="p"
      subscribe={never}
    />
  );
}

describe("the feed as a way to follow a status page", () => {
  test("a page that offers no channel still shows the card, with the feed alone and no choice", () => {
    const html = card([]);
    expect(html).toContain('data-slot="subscribe"');
    expect(html).toContain('data-slot="subscribe-feed"');
    // The address is a machine token, left to right, whole.
    const address = html.split('data-slot="subscribe-feed-address"')[1] ?? "";
    expect(address).toContain(`dir="ltr">${feed}</bdi>`);
    expect(html).not.toContain('data-slot="subscribe-channel"');
    expect(html).not.toContain('name="address"');
  });

  test("a page that offers channels offers the feed beside them, its first channel chosen", () => {
    const html = card(["email", "webhook"]);
    expect(html).toContain('data-value="email"');
    expect(html).toContain('data-value="webhook"');
    expect(html).toContain('data-value="feed"');
    expect(html).toContain('name="address"');
    expect(html).not.toContain('data-slot="subscribe-feed"');
  });

  test("a page that offers one channel offers it and the feed as a choice", () => {
    const html = card(["webhook"]);
    expect(html).toContain('data-slot="subscribe-channel"');
    expect(html).toContain('data-value="webhook"');
    expect(html).toContain('data-value="feed"');
  });

  test("without JavaScript a page that offers channels still links the feed", () => {
    const noscript = card(["email"]).match(noscriptPart)?.[1];
    expect(noscript).toContain(`href="${feed}"`);
  });
});
