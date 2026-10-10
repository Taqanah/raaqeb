/**
 * When something breaks: one outage from the first failed check to
 * the recovery as a frame, the time draggable along a rail that fills red
 * while the monitor is down and green once it is back, and what each channel
 * receives drawn as its app shows it, in the page's language, arriving at
 * its moment. Plays once as the section comes into view.
 */
import {
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIcon,
  CheckIcon,
  MailIcon,
  SendIcon,
  WebhookIcon,
  XIcon,
} from "@/shared/ui/icons.tsx";
import type { Copy } from "~/copy.ts";
import { Logo } from "./logos.tsx";
import { Frame, Section, useSeen } from "./section.tsx";

/** The rail's length in seconds: the outage, then a stretch of recovery so the green reads. */
const last = 360;
/** How long the outage takes to play, in ms. */
const playMs = 6000;
const node = {
  down: "text-down",
  sent: "text-teal-text",
  up: "text-up",
} as const;
const nodeIcon = {
  down: <XIcon />,
  sent: <SendIcon />,
  up: <CheckIcon />,
} as const;

function clock(second: number): string {
  const total = 14 * 3600 + 2 * 60 + 10 + second;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function Alerts({ copy }: { readonly copy: Copy }): ReactNode {
  const a = copy.alerts;
  const [at, setAt] = useState(0);
  const touched = useRef<boolean>(false);
  const [ref, seen] = useSeen();
  // Plays once when the section comes into view; a touch of the rail stops it.
  useEffect(() => {
    if (!seen || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    // One frame at a time over the play's length, eased in and out, so the rail glides instead of stepping.
    const started = performance.now();
    let frame = 0;
    const play = (now: number) => {
      if (touched.current) {
        return;
      }
      const t = Math.min(1, (now - started) / playMs);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      setAt(eased * last);
      if (t < 1) {
        frame = requestAnimationFrame(play);
      }
    };
    frame = requestAnimationFrame(play);
    return () => cancelAnimationFrame(frame);
  }, [seen]);
  const scrub = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setAt(Number(e.currentTarget.value));
  }, []);
  const touch = useCallback(() => {
    touched.current = true;
  }, []);
  const down = at >= 21;
  const up = at >= 270;
  return (
    <Section backdrop="dots" id="alerts" lead={a.lead} title={a.title}>
      <div ref={ref}>
        <Frame>
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] max-lg:grid-cols-1">
            <div className="border-line border-e p-6 max-lg:border-e-0 max-lg:border-b">
              <div className="flex items-center justify-between gap-3">
                <span className="token text-[14px] text-strong">
                  https://pay.raaqeb.dev
                </span>
                <span className="token text-[14px] text-fg">
                  {clock(Math.floor(at))}
                </span>
              </div>
              <input
                aria-label={a.scrub}
                className="scrub mt-5"
                max={last}
                min={0}
                onChange={scrub}
                onPointerDown={touch}
                step="any"
                style={
                  {
                    "--at": `${(at / last) * 100}%`,
                    "--tone": up ? "var(--up)" : "var(--down)",
                  } as CSSProperties
                }
                type="range"
                value={at}
              />
              <ol className="mt-5">
                {a.steps.map((step) => (
                  <li
                    className={`grid grid-cols-[22px_auto_1fr] items-center gap-x-3 py-2.5 transition-opacity duration-300 ${at >= step.second ? "" : "opacity-30"}`}
                    key={step.at}
                  >
                    <span
                      className={`grid size-[22px] place-items-center rounded-full shadow-[inset_0_0_0_1.5px_currentColor] [&>svg]:size-3 [&>svg]:stroke-3 ${node[step.kind]}`}
                    >
                      {nodeIcon[step.kind]}
                    </span>
                    <time className="token text-[12px] text-strong">
                      {step.at}
                    </time>
                    <span className="text-[14px]">{step.what}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="grid grid-cols-2 gap-px bg-line-2 max-md:grid-cols-1">
              <Channel
                head={
                  <>
                    <Logo brand="slack" className="size-4" colored />
                    <span className="font-medium text-fg">{a.channel}</span>
                  </>
                }
                lang={copy.locale}
              >
                <Chat
                  at="14:02"
                  name={copy.brand}
                  on={down}
                  text={a.down[1]}
                  title={a.down[0]}
                  tone="down"
                />
                <Chat
                  at="14:06"
                  name={copy.brand}
                  on={up}
                  text={a.up[1]}
                  title={a.up[0]}
                  tone="up"
                />
              </Channel>
              <Channel
                className="bg-chat"
                head={
                  <>
                    <Logo brand="telegram" className="size-4" colored />
                    <span className="font-medium text-fg">{copy.brand}</span>
                  </>
                }
                lang={copy.locale}
              >
                <Bubble
                  at="14:02"
                  on={down}
                  text={a.down[1]}
                  title={a.down[0]}
                  tone="down"
                />
                <Bubble
                  at="14:06"
                  on={up}
                  text={a.up[1]}
                  title={a.up[0]}
                  tone="up"
                />
              </Channel>
              <Channel
                head={
                  <>
                    <MailIcon className="size-4 text-muted" />
                    <span className="font-medium text-fg">{a.email}</span>
                  </>
                }
                lang={copy.locale}
              >
                <Mail
                  at="14:06"
                  from={copy.brand}
                  on={up}
                  text={a.up[1]}
                  title={a.up[0]}
                  tone="up"
                />
                <Mail
                  at="14:02"
                  from={copy.brand}
                  on={down}
                  text={a.down[1]}
                  title={a.down[0]}
                  tone="down"
                />
              </Channel>
              <Channel
                className="bg-soft"
                head={
                  <>
                    <Logo brand="ntfy" className="size-4" colored />
                    <span className="font-medium text-fg">ntfy</span>
                  </>
                }
                lang={copy.locale}
              >
                <Push
                  at="14:06"
                  on={up}
                  text={a.up[1]}
                  title={a.up[0]}
                  tone="up"
                />
                <Push
                  at="14:02"
                  on={down}
                  text={a.down[1]}
                  title={a.down[0]}
                  tone="down"
                />
              </Channel>
            </div>
          </div>
        </Frame>
      </div>
      <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-3 text-strong">
        <span className="font-medium text-fg">{a.through}</span>
        <Through icon={<MailIcon className="text-muted" />} name={a.email} />
        <Through icon={<Logo brand="slack" colored />} name="Slack" />
        <Through icon={<Logo brand="discord" colored />} name="Discord" />
        <Through icon={<Logo brand="telegram" colored />} name="Telegram" />
        <Through icon={<Logo brand="ntfy" colored />} name="ntfy" />
        <Through icon={<WebhookIcon className="text-muted" />} name="Webhook" />
      </div>
    </Section>
  );
}

function Channel({
  children,
  className = "bg-surface",
  head,
  lang,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly head: ReactNode;
  readonly lang: "ar" | "en";
}): ReactNode {
  return (
    <div
      className={`flex min-h-52 flex-col gap-3 p-4 text-[13px] ${className}`}
      dir={lang === "ar" ? "rtl" : "ltr"}
      lang={lang}
    >
      <div className="flex items-center gap-2 text-[13px]">{head}</div>
      {children}
    </div>
  );
}

type Tone = "down" | "up";

/** A message as it lands: a wash in its state's colour that fades, so the eye catches it. */
const wash: Readonly<Record<Tone, string>> = {
  down: "wash-down",
  up: "wash-up",
};

/** The product's mark, as the sender's picture in a chat or an inbox. */
function Avatar({ round = false }: { readonly round?: boolean }): ReactNode {
  return (
    <span
      className={`grid size-8 shrink-0 place-items-center bg-action text-action-fg [&>svg]:size-4 ${round ? "rounded-full" : "rounded-md"}`}
    >
      <ActivityIcon />
    </span>
  );
}

/** A Slack message from the app: its picture, its name and time, then the subject and the body as the product sends them. */
function Chat({
  at,
  name,
  on,
  text,
  title,
  tone,
}: {
  readonly at: string;
  readonly name: string;
  readonly on: boolean;
  readonly text: string;
  readonly title: string;
  readonly tone: Tone;
}): ReactNode {
  if (!on) {
    return null;
  }
  return (
    <div
      className={`arrive -mx-2 flex gap-2.5 rounded-md px-2 py-1.5 ${wash[tone]}`}
    >
      <Avatar />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{name}</span>
          <span className="token text-[11px] text-muted">{at}</span>
        </div>
        <p>{title}</p>
        <p className="mt-1">{text}</p>
      </div>
    </div>
  );
}

/** A Telegram message from the bot: a bubble on the chat's backdrop, the time in its corner. */
function Bubble({
  at,
  on,
  text,
  title,
  tone,
}: {
  readonly at: string;
  readonly on: boolean;
  readonly text: string;
  readonly title: string;
  readonly tone: Tone;
}): ReactNode {
  if (!on) {
    return null;
  }
  return (
    <div
      className={`arrive w-[92%] self-start rounded-2xl rounded-ss-md bg-surface px-3.5 py-2.5 shadow-[0_1px_2px_oklch(0%_0_0/0.12)] ${wash[tone]}`}
    >
      <p>{title}</p>
      <p className="mt-2">{text}</p>
      <span className="token mt-1 block text-end text-[11px] text-muted">
        {at}
      </span>
    </div>
  );
}

/** An inbox row: the sender, the subject and the start of the body, newest on top. */
function Mail({
  at,
  from,
  on,
  text,
  title,
  tone,
}: {
  readonly at: string;
  readonly from: string;
  readonly on: boolean;
  readonly text: string;
  readonly title: string;
  readonly tone: Tone;
}): ReactNode {
  if (!on) {
    return null;
  }
  return (
    <div
      className={`arrive -mx-2 flex gap-3 rounded-md border-line-2 border-b px-2 pt-1.5 pb-3 last:border-0 ${wash[tone]}`}
    >
      <Avatar round />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold">{from}</span>
          <span className="token text-[11px] text-muted">{at}</span>
        </div>
        <p className="truncate font-medium">{title}</p>
        <p className="truncate text-muted">{text}</p>
      </div>
    </div>
  );
}

/** A channel the alerts go through, by its mark and name. */
function Through({
  icon,
  name,
}: {
  readonly icon: ReactNode;
  readonly name: string;
}): ReactNode {
  return (
    <span className="inline-flex items-center gap-2 font-medium [&>svg]:size-5">
      {icon}
      {name}
    </span>
  );
}

/** An ntfy notification on a phone: the app's mark, its name and time, the subject and the body. */
function Push({
  at,
  on,
  text,
  title,
  tone,
}: {
  readonly at: string;
  readonly on: boolean;
  readonly text: string;
  readonly title: string;
  readonly tone: Tone;
}): ReactNode {
  if (!on) {
    return null;
  }
  return (
    <div
      className={`arrive flex gap-3 rounded-2xl bg-surface p-3 shadow-[0_6px_18px_-10px_oklch(0%_0_0/0.35)] ${wash[tone]}`}
    >
      <Logo brand="ntfy" className="size-8 shrink-0" colored />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
          <span>ntfy</span>
          <span className="token">{at}</span>
        </div>
        <p className="font-semibold">{title}</p>
        <p className="truncate">{text}</p>
      </div>
    </div>
  );
}
