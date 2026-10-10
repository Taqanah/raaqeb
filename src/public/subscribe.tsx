/**
 * Subscribing to a status page: the dialog the
 * overview's header button opens, and a subscription's own page,
 * where its link leads. The dialog is a native popover, so the button opens
 * it, Escape and a tap outside close it, and focus returns to the button,
 * all without JavaScript, which keeps the feed one click away. The card offers each channel the page offers and the feed
 * beside them, the feed alone when the page offers none. The form
 * posts through a server function once hydrated and has no plain-POST
 * fallback: without JavaScript its `<noscript>` line says so and links the
 * feed. It answers the same whether the address was new,
 * pending or confirmed. The subscription's page is in the subscription
 * language; opening it changes nothing, and its buttons are plain forms
 * that post to the confirm and unsubscribe addresses, so they work without
 * JavaScript and a mail scanner that opens links acts on none.
 */
import {
  type ReactNode,
  type SyntheticEvent,
  type ToggleEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { SubscriptionChannel } from "@/shared/schemas/page.ts";
import {
  type SubscribeInput,
  type SubscribeRefusal,
  type SubscribeResult,
  type SubscriptionView,
  subscribeInputSchema,
  subscriptionPath,
} from "@/shared/schemas/subscription.ts";
import { Button, buttonVariants } from "@/shared/ui/button.tsx";
import { Card } from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  BellIcon,
  CheckIcon,
  CopyIcon,
  MailIcon,
  RssIcon,
  WebhookIcon,
  XIcon,
} from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { quietLink } from "./link.tsx";

/** How the form's post reaches the server: the route hands its server function in. */
export type Subscribe = (input: SubscribeInput) => Promise<SubscribeResult>;

const channelWords: Readonly<Record<SubscriptionChannel, MessageId>> = {
  email: "public_subscribe_email",
  webhook: "public_subscribe_webhook",
};

/** What a visitor may pick on the card: a channel the page offers, or its feed, which needs no subscription. */
type Choice = SubscriptionChannel | "feed";

const choiceWords: Readonly<Record<Choice, MessageId>> = {
  ...channelWords,
  feed: "public_subscribe_feed_choice",
};

const choiceIcons = {
  email: MailIcon,
  feed: RssIcon,
  webhook: WebhookIcon,
} as const;

const fieldWords: Readonly<Record<SubscriptionChannel, MessageId>> = {
  email: "public_subscribe_email_label",
  webhook: "public_subscribe_webhook_label",
};

const sentWords: Readonly<Record<SubscriptionChannel, MessageId>> = {
  email: "public_subscribe_sent_email",
  webhook: "public_subscribe_sent_webhook",
};

const refusalWords: Readonly<
  Record<Exclude<SubscribeRefusal, "invalid">, MessageId>
> = {
  limited: "public_subscribe_limited",
  not_found: "public_subscribe_not_offered",
  not_offered: "public_subscribe_not_offered",
  unavailable: "public_subscribe_unavailable",
  unreachable: "public_subscribe_unreachable",
};

const invalidWords: Readonly<Record<SubscriptionChannel, MessageId>> = {
  email: "public_subscribe_invalid_email",
  webhook: "public_subscribe_invalid_webhook",
};

/** Where the form stands: typing, posting, sent through a channel, or refused. */
type FormState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly channel: SubscriptionChannel; readonly kind: "sent" }
  | {
      readonly channel: SubscriptionChannel;
      readonly kind: "refused";
      readonly reason: SubscribeRefusal;
    };

/** The id the header's button names to open the subscribe dialog. */
const dialogId = "subscribe-dialog";

/** The header's button that opens the subscribe dialog; outline, since the form's own button is the page's primary action. */
export function SubscribeButton(): ReactNode {
  const { t } = useMessages();
  return (
    <button
      className={buttonVariants({ size: "sm", variant: "outline" })}
      data-slot="subscribe-open"
      popoverTarget={dialogId}
      type="button"
    >
      <BellIcon />
      {t("public_subscribe_title")}
    </button>
  );
}

/** Opening the dialog moves focus to its first control: the chosen choice, else the copy button. */
function focusFirst(event: ToggleEvent<HTMLElement>): void {
  if (event.newState === "open") {
    event.currentTarget
      .querySelector<HTMLElement>(
        '[data-slot=subscribe-channel] [tabindex="0"], [data-slot=subscribe-copy]'
      )
      ?.focus();
  }
}

/** The subscribe dialog: a choice of each channel the page offers and the feed, then the address form or the feed's address. */
export function SubscribeForm({
  channels,
  feed,
  locale,
  pageId,
  subscribe,
}: {
  readonly channels: readonly SubscriptionChannel[];
  /** The feed in the view's locale, absolute when the page has an origin: the address a feed reader is given, and the `<noscript>` line's link. */
  readonly feed: string;
  /** The locale of the address the visitor is on: the subscription language. */
  readonly locale: Locale;
  readonly pageId: string;
  readonly subscribe: Subscribe;
}): ReactNode {
  const { t } = useMessages();
  const choices = useMemo<readonly Choice[]>(
    () => [...channels, "feed"],
    [channels]
  );
  const [chosen, setChoice] = useState<Choice>(channels[0] ?? "feed");
  // A live refresh may drop the chosen channel from the offer; the card then follows the first choice left.
  const choice = choices.includes(chosen) ? chosen : (choices[0] ?? "feed");
  const channel = choice === "feed" ? undefined : choice;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  const onChoice = useCallback(
    (value: unknown) => {
      const picked = choices.find((each) => each === value);
      if (picked) {
        setChoice(picked);
      }
    },
    [choices]
  );
  return (
    <div
      aria-labelledby="subscribe-title"
      // A sheet along a phone's foot, full width; a centred card from the small breakpoint up. No display class: the closed popover's own display:none must win.
      className="inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-xl border border-border bg-card p-5 text-card-foreground text-sm shadow-lg backdrop:bg-black/40 sm:inset-0 sm:m-auto sm:h-fit sm:w-[min(32rem,calc(100%-2rem))] sm:rounded-xl"
      data-slot="subscribe"
      id={dialogId}
      onToggle={focusFirst}
      popover="auto"
      role="dialog"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="font-medium text-base" id="subscribe-title">
              {t("public_subscribe_title")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("public_subscribe_description")}
            </p>
          </div>
          <button
            aria-label={t("app_close")}
            className="-m-1 rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            popoverTarget={dialogId}
            popoverTargetAction="hide"
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3">
          {choices.length > 1 ? (
            <Choices choice={choice} choices={choices} onChoice={onChoice} />
          ) : null}
          {channel ? (
            // A new channel starts a new form, its address and answer empty.
            <AddressForm
              channel={channel}
              feed={feed}
              key={channel}
              locale={locale}
              pageId={pageId}
              ready={ready}
              subscribe={subscribe}
            />
          ) : (
            <FeedAddress feed={feed} ready={ready} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The form of one channel: the address, the button that posts it, and the answer line. */
function AddressForm({
  channel,
  feed,
  locale,
  pageId,
  ready,
  subscribe,
}: {
  readonly channel: SubscriptionChannel;
  readonly feed: string;
  readonly locale: Locale;
  readonly pageId: string;
  /** Hydrated: the form posts through a server function (ADR-0006). */
  readonly ready: boolean;
  readonly subscribe: Subscribe;
}): ReactNode {
  const { t } = useMessages();
  const [address, setAddress] = useState("");
  const [state, setState] = useState<FormState>({ kind: "idle" });
  const onAddress = useCallback(
    (event: { readonly target: { readonly value: string } }) => {
      setAddress(event.target.value);
    },
    []
  );
  const onSubmit = useCallback(
    (event: SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = subscribeInputSchema.safeParse({
        address,
        channel,
        locale,
        pageId,
      });
      if (!parsed.success) {
        setState({ channel, kind: "refused", reason: "invalid" });
        return;
      }
      setState({ kind: "sending" });
      subscribe(parsed.data)
        .then((result) => {
          setState(
            result.ok
              ? { channel, kind: "sent" }
              : { channel, kind: "refused", reason: result.reason }
          );
          if (result.ok) {
            setAddress("");
          }
        })
        .catch(() => {
          setState({ channel, kind: "refused", reason: "unavailable" });
        });
    },
    [address, channel, locale, pageId, subscribe]
  );
  const refused = state.kind === "refused";
  // A refusal of the address itself marks the field: an invalid one, or a webhook off the public internet.
  const fieldRefused =
    refused && (state.reason === "invalid" || state.reason === "unreachable");
  return (
    <form
      className="flex flex-col gap-3"
      data-slot="subscribe-form"
      noValidate
      onSubmit={onSubmit}
    >
      <label className="font-medium text-sm" htmlFor="subscribe-address">
        {t(fieldWords[channel])}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-describedby="subscribe-answer"
          aria-invalid={fieldRefused}
          autoComplete={channel === "email" ? "email" : "url"}
          dir="ltr"
          id="subscribe-address"
          inputMode={channel === "email" ? "email" : "url"}
          name="address"
          onChange={onAddress}
          placeholder={
            channel === "email"
              ? "name@example.com"
              : "https://hooks.example.com/…"
          }
          type={channel === "email" ? "email" : "url"}
          value={address}
          // A webhook's URL is a machine token; an email address is a person's and keeps the page's face.
          variant={channel === "webhook" ? "token" : undefined}
        />
        <Button
          className="shrink-0"
          data-slot="subscribe-submit"
          // Without JavaScript the form cannot post (ADR-0006): the button waits for hydration.
          disabled={!ready || state.kind === "sending"}
          type="submit"
        >
          {t(
            state.kind === "sending"
              ? "public_subscribe_sending"
              : "public_subscribe_submit"
          )}
        </Button>
      </div>
      <p
        aria-live="polite"
        className={cn(
          "text-sm empty:sr-only",
          refused ? "text-destructive" : "text-muted-foreground"
        )}
        data-slot="subscribe-answer"
        data-state={state.kind}
        id="subscribe-answer"
        role="status"
      >
        {answerOf(state, t)}
      </p>
      <noscript>
        <p
          className="text-muted-foreground text-sm"
          data-slot="subscribe-noscript"
        >
          {t("public_subscribe_noscript")}{" "}
          <a className={cn(quietLink, "underline")} href={feed}>
            {t("public_subscribe_feed")}
          </a>
        </p>
      </noscript>
    </form>
  );
}

/** The card's choice: each channel the page offers, then the feed. */
function Choices({
  choice,
  choices,
  onChoice,
}: {
  readonly choice: Choice;
  readonly choices: readonly Choice[];
  readonly onChoice: (value: unknown) => void;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Segmented
      aria-label={t("public_subscribe_by")}
      // A phone holds three choices once their icons go; each takes its own width, so a long Arabic label never wraps.
      className="w-auto self-start max-sm:self-stretch"
      data-slot="subscribe-channel"
      onValueChange={onChoice}
      value={choice}
    >
      {choices.map((each) => {
        const Icon = choiceIcons[each];
        return (
          <SegmentedItem
            className="flex-auto whitespace-nowrap max-sm:px-2 max-sm:[&_svg]:hidden"
            key={each}
            value={each}
          >
            <Icon />
            {t(choiceWords[each])}
          </SegmentedItem>
        );
      })}
    </Segmented>
  );
}

/** The feed's address, a machine token a feed reader is given, with a button that copies it. */
function FeedAddress({
  feed,
  ready,
}: {
  readonly feed: string;
  /** Hydrated: copying needs JavaScript (ADR-0006). */
  readonly ready: boolean;
}): ReactNode {
  const { t } = useMessages();
  const field = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const later = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(later);
  }, [copied]);
  // Where the clipboard is refused (a page over plain http has none), the address is selected for the visitor to copy.
  const select = useCallback(() => {
    if (field.current) {
      getSelection()?.selectAllChildren(field.current);
    }
  }, []);
  const onCopy = useCallback(() => {
    const written = navigator.clipboard?.writeText(feed);
    if (!written) {
      select();
      return;
    }
    written.then(() => setCopied(true), select);
  }, [feed, select]);
  return (
    <div className="flex flex-col gap-3" data-slot="subscribe-feed">
      <p className="font-medium text-sm" id="subscribe-feed-label">
        {t("public_subscribe_feed_label")}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        {/* A box, not a field, so a long address wraps whole on a phone; one click selects all of it. */}
        <Token
          aria-describedby="subscribe-feed-hint"
          aria-labelledby="subscribe-feed-label"
          className="block min-h-control flex-1 select-all break-all rounded-lg border border-input bg-background px-3 py-2 text-sm"
          data-slot="subscribe-feed-address"
          ref={field}
        >
          {feed}
        </Token>
        <Button
          className="shrink-0"
          data-slot="subscribe-copy"
          disabled={!ready}
          onClick={onCopy}
          type="button"
          variant="outline"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span aria-live="polite">
            {t(copied ? "public_subscribe_copied" : "public_subscribe_copy")}
          </span>
        </Button>
      </div>
      <p className="text-muted-foreground text-sm" id="subscribe-feed-hint">
        {t("public_subscribe_feed_hint")}
      </p>
    </div>
  );
}

/** The answer line's words for where the form stands. */
function answerOf(
  state: FormState,
  t: ReturnType<typeof useMessages>["t"]
): string {
  switch (state.kind) {
    case "sent":
      return t(sentWords[state.channel]);
    case "refused":
      return state.reason === "invalid"
        ? t(invalidWords[state.channel])
        : t(refusalWords[state.reason]);
    default:
      return "";
  }
}

const stateWords: Readonly<Record<SubscriptionView["state"], MessageId>> = {
  confirmed: "public_subscription_confirmed",
  expired: "public_subscription_expired",
  pending: "public_subscription_pending",
  unsubscribed: "public_subscription_unsubscribed",
};

/** A subscription's own page: what it is, where it stands, and the button that moves it. */
export function SubscriptionPanel({
  overview,
  subscription,
  token,
}: {
  /** The page's overview, where a new sign-up is made. */
  readonly overview: string;
  readonly subscription: SubscriptionView;
  readonly token: string;
}): ReactNode {
  const { t } = useMessages();
  const { state } = subscription;
  const action = (name: "confirm" | "unsubscribe", words: MessageId) => (
    <form action={`${subscriptionPath(token)}/${name}`} method="post">
      <Button
        data-slot={`subscription-${name}`}
        type="submit"
        variant={name === "confirm" ? "default" : "outline"}
      >
        {t(words)}
      </Button>
    </form>
  );
  return (
    <Card
      as="section"
      className="px-(--card-spacing)"
      data-slot="subscription"
      data-state={state}
    >
      <h2 className="font-medium text-base">
        {t("public_subscription_title")}
      </h2>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {t(channelWords[subscription.channel])}
        </span>
        <Token data-slot="subscription-address">{subscription.address}</Token>
      </p>
      <p className="text-sm">{t(stateWords[state])}</p>
      {state === "pending" || state === "confirmed" ? (
        <div className="flex flex-wrap gap-3">
          {state === "pending"
            ? action("confirm", "public_subscription_confirm")
            : null}
          {action("unsubscribe", "public_subscription_unsubscribe")}
        </div>
      ) : null}
      <p className="text-sm">
        <a
          className={cn(quietLink, "underline")}
          data-slot="subscription-page"
          href={overview}
        >
          {t(
            state === "expired" || state === "unsubscribed"
              ? "public_subscription_again"
              : "public_current_status"
          )}
        </a>
      </p>
    </Card>
  );
}
