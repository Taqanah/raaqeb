/**
 * The sample status page: an invented store's components over 90
 * days, drawn as the product draws them, in either language whatever the
 * page's, with a day card on hover or focus, a group that unfolds, and
 * optionally an open incident and a scheduled window above the components,
 * as the product's overview shows them.
 */
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { directionOf, type Locale } from "@/shared/i18n/locale.ts";
import {
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  TriangleAlertIcon,
} from "@/shared/ui/icons.tsx";
import { floatingFrom, placeOf } from "@/shared/ui/uptime-bar.tsx";
import { copies, type Demo, type Level } from "~/copy.ts";

export type Calendar = "gregory" | "islamic-umalqura";

interface SampleDay {
  readonly downtime: number;
  readonly incident: boolean;
  readonly level: Level;
  readonly response: number;
  readonly uptime: number;
}

/** A level's uptime and its minutes down, for a sample day. */
const figures: Readonly<Record<Level, readonly [number, number]>> = {
  degraded: [99.4, 9],
  down: [96.9, 45],
  maintenance: [100, 0],
  partial: [98.6, 20],
  up: [100, 0],
};

/** 90 days, oldest first, up except the bad days, named by how many days ago they were. */
function days(
  bad: Readonly<Record<number, Level>>,
  incidents: readonly number[] = []
): readonly SampleDay[] {
  return Array.from({ length: 90 }, (_, i) => {
    const ago = 89 - i;
    const level = bad[ago] ?? "up";
    const [uptime, downtime] = figures[level];
    return {
      downtime,
      incident: incidents.includes(ago),
      level,
      // A mean response that drifts a little from day to day.
      response: 120 + Math.round(40 * Math.sin(i / 5) + 15 * Math.sin(i * 1.3)),
      uptime,
    };
  });
}

export const sample = {
  components: [
    days({ 5: "degraded", 23: "degraded", 47: "partial", 71: "degraded" }),
    days(
      {
        3: "down",
        12: "degraded",
        19: "degraded",
        41: "partial",
        62: "degraded",
        80: "down",
      },
      [3]
    ),
    days({ 9: "degraded", 17: "degraded", 33: "down", 58: "partial" }),
    days({ 2: "partial", 26: "degraded", 44: "down", 68: "degraded" }),
  ],
  grouped: [days({ 28: "degraded", 66: "partial" }), days({ 14: "down" })],
} as const;

function uptimeOf(shown: readonly SampleDay[]): string {
  const mean = shown.reduce((sum, day) => sum + day.uptime, 0) / shown.length;
  return `${mean.toFixed(2)}%`;
}

/** The date the page is prerendered against; the browser's own date replaces it after mount. */
const anchor = Date.UTC(2026, 9, 8);
const dayMs = 86_400_000;

/** The level's colour as the text colour, for the card's status word. */
const levelText: Readonly<Record<Level, string>> = {
  degraded: "text-degraded-text",
  down: "text-down-text",
  maintenance: "text-maintenance-text",
  partial: "text-partial-text",
  up: "text-up-text",
};

export function StatusPage({
  bare = false,
  calendar,
  className = "",
  compact = false,
  lang,
  played,
}: {
  /** The components alone: no name, no group and no footer, as the hero shows them. */
  readonly bare?: boolean;
  /** The calendar of the day cards; Hijri in Arabic and Gregorian in English unless given. */
  readonly calendar?: Calendar;
  readonly className?: string;
  /** Two components over 30 days, no group and no footer. */
  readonly compact?: boolean;
  readonly lang: Locale;
  /** An incident and a scheduled maintenance window above the components, with this many of the incident's updates posted so far (1 to 4); none when absent. */
  readonly played?: number;
}): ReactNode {
  const dated = calendar ?? (lang === "ar" ? "islamic-umalqura" : "gregory");
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState(anchor);
  useEffect(() => {
    setToday(Date.now());
  }, []);
  const { demo } = copies[lang];
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const shown = compact ? 30 : 90;
  const rows = compact ? 2 : 4;
  const pad = compact ? "px-4" : "px-6";
  return (
    <div
      className={`bg-surface text-start ${className}`}
      dir={directionOf(lang)}
      lang={lang}
    >
      <div className={`${pad} ${bare || compact ? "pt-1" : "pt-2"}`}>
        {played === undefined ? (
          <Banner demo={demo} ok />
        ) : (
          <Notices demo={demo} played={played} />
        )}
        <div className="mt-5 flex items-baseline justify-between text-[12px] text-faint">
          <span>{compact ? demo.days.replace("90", "30") : demo.days}</span>
          <span>{demo.today}</span>
        </div>
        <ul>
          {demo.components.slice(0, rows).map((name, i) => (
            <Row
              calendar={dated}
              days={(sample.components[i] ?? sample.components[0]).slice(
                -shown
              )}
              degraded={played !== undefined && played < 4 && i === 1}
              demo={demo}
              key={name}
              lang={lang}
              name={name}
              today={today}
            />
          ))}
        </ul>
        {compact || bare ? null : (
          <div className="border-line border-t">
            <button
              aria-expanded={open}
              className="flex w-full cursor-pointer items-center gap-2.5 py-3.5 text-start text-sm"
              onClick={toggle}
              type="button"
            >
              <ChevronDownIcon
                className={`size-4 text-faint transition-transform ${open ? "rotate-180" : ""}`}
              />
              <span className="font-medium">{demo.group}</span>
              <span className="ms-auto flex items-center gap-2 text-[13px] text-muted max-md:hidden">
                <span className="size-2 rounded-full bg-up" />
                {demo.groupUp}
              </span>
            </button>
            {open ? (
              <ul className="arrive ps-6.5">
                {demo.grouped.map((name, i) => (
                  <Row
                    calendar={dated}
                    days={sample.grouped[i] ?? sample.grouped[0]}
                    degraded={false}
                    demo={demo}
                    key={name}
                    lang={lang}
                    name={name}
                    today={today}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>
      <div className="h-4" />
    </div>
  );
}

/** The page's overall status: a filled green check and the sentence, or the amber sign while something is degraded. */
function Banner({
  demo,
  ok,
}: {
  readonly demo: Demo;
  readonly ok: boolean;
}): ReactNode {
  return ok ? (
    <div className="mt-4 flex items-center gap-2.5 font-medium text-[17px]">
      <span className="grid size-5.5 shrink-0 place-items-center rounded-full bg-up text-surface">
        <CheckIcon className="size-3.5" strokeWidth={3} />
      </span>
      {demo.banner}
    </div>
  ) : (
    <div className="mt-4 flex items-center gap-2.5 font-medium text-[17px] text-degraded-text">
      <TriangleAlertIcon className="size-5.5 shrink-0 text-degraded" />
      {demo.bannerDegraded}
    </div>
  );
}

/** The incident as its updates are posted, newest first, and the window scheduled for Friday; the banner turns green when the incident is resolved. */
function Notices({
  demo,
  played,
}: {
  readonly demo: Demo;
  readonly played: number;
}): ReactNode {
  const resolved = played >= demo.updates.length;
  const posted = demo.updates.slice(0, played).toReversed();
  // The newest update's dot takes the incident's colour; the older ones go quiet.
  const latest = resolved ? "bg-up" : "bg-degraded";
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Banner demo={demo} key={resolved ? "ok" : "degraded"} ok={resolved} />
        {/* A visitor's way in to the updates; the sample does nothing with it. */}
        <button
          className="mt-4 inline-flex h-9 shrink-0 cursor-pointer items-center rounded-lg bg-action px-4 font-medium text-[14px] text-action-fg transition-transform hover:-translate-y-px active:translate-y-0"
          type="button"
        >
          {demo.subscribe}
        </button>
      </div>
      <article className="mt-5 border-line border-t pt-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="font-medium text-[16px]">{demo.incidentTitle}</h3>
          <span
            className={`font-medium text-[13px] ${resolved ? "text-up-text" : "text-degraded-text"}`}
          >
            {resolved ? demo.updates.at(-1)?.[0] : demo.incidentImpact}
          </span>
        </div>
        <ol className="mt-3 border-line border-s ps-4">
          {posted.map(([stage, text, at], n) => (
            <li
              className={`relative pb-3 last:pb-0 ${n === 0 ? "arrive" : ""}`}
              key={stage}
            >
              <span
                className={`absolute -start-[1.3rem] top-1.5 size-2.5 rounded-full ring-4 ring-surface ${n === 0 ? latest : "bg-line"}`}
              />
              <p className="flex items-baseline gap-2 text-[13px]">
                <span className="font-medium">{stage}</span>
                <span className="token text-[12px] text-muted">{at}</span>
              </p>
              <p className="text-[14px] text-strong">{text}</p>
            </li>
          ))}
        </ol>
      </article>
      <article className="mt-4 flex items-start gap-3 border-line border-t pt-4">
        <CalendarIcon className="mt-0.5 size-4 shrink-0 text-maintenance" />
        <div>
          <h3 className="font-medium text-[15px]">{demo.maintenanceTitle}</h3>
          <p className="text-[13px] text-strong">{demo.maintenanceWhen}</p>
        </div>
      </article>
    </>
  );
}

/** The open day: its place in the bar and where its card sits on the screen. */
interface Opened {
  readonly index: number;
  readonly place: CSSProperties;
}

/** The day an event came from and where its card goes, placed as the product places it (src/shared/ui/uptime-bar.tsx). */
function openedAt(target: EventTarget): Opened | null {
  const cell =
    target instanceof HTMLElement
      ? target.closest<HTMLElement>("[data-index]")
      : null;
  const bar = cell?.parentElement;
  if (!(cell && bar)) {
    return null;
  }
  return {
    index: Number(cell.dataset.index),
    place: placeOf(
      cell.getBoundingClientRect(),
      bar.getBoundingClientRect(),
      matchMedia(floatingFrom).matches
    ),
  };
}

/** A day's card in the top layer, so no frame or panel around the page clips or covers it. */
function Card({
  children,
  place,
}: {
  readonly children: ReactNode;
  readonly place: CSSProperties;
}): ReactNode {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.showPopover();
  }, []);
  return (
    <div
      className="m-0 overflow-visible border-0 bg-transparent p-0 text-fg"
      popover="manual"
      ref={card}
      style={place}
    >
      {children}
    </div>
  );
}

function Row({
  calendar,
  days: shown,
  degraded,
  demo,
  lang,
  name,
  today,
}: {
  readonly calendar: Calendar;
  readonly days: readonly SampleDay[];
  /** Whether the component is degraded right now (the open incident's). */
  readonly degraded: boolean;
  readonly demo: Demo;
  readonly lang: Locale;
  readonly name: string;
  readonly today: number;
}): ReactNode {
  const [opened, setOpened] = useState<Opened | null>(null);
  const enter = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const next = openedAt(e.target);
    if (next) {
      setOpened(next);
    }
  }, []);
  const focus = useCallback((e: FocusEvent<HTMLDivElement>) => {
    const next = openedAt(e.target);
    if (next) {
      setOpened(next);
    }
  }, []);
  // A placed card would drift from its cell, so a scroll or a resize closes it.
  useEffect(() => {
    if (!opened) {
      return;
    }
    const drop = () => setOpened(null);
    window.addEventListener("scroll", drop, { capture: true, passive: true });
    window.addEventListener("resize", drop);
    return () => {
      window.removeEventListener("scroll", drop, { capture: true });
      window.removeEventListener("resize", drop);
    };
  }, [opened]);
  const blur = useCallback((e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setOpened(null);
    }
  }, []);
  const leave = useCallback(() => setOpened(null), []);
  // Days run in the reading direction, so the arrow toward the line's end is the next day; Escape closes the card.
  const key = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        setOpened(null);
        return;
      }
      const forward = lang === "ar" ? "ArrowLeft" : "ArrowRight";
      const back = lang === "ar" ? "ArrowRight" : "ArrowLeft";
      const cell = e.target instanceof HTMLElement ? e.target : null;
      if (!(cell?.dataset.index && (e.key === forward || e.key === back))) {
        return;
      }
      const index = Number(cell.dataset.index) + (e.key === forward ? 1 : -1);
      const next = cell.parentElement?.querySelector<HTMLElement>(
        `[data-index="${index}"]`
      );
      // A day this screen hides is never reached.
      if (next?.checkVisibility()) {
        e.preventDefault();
        next.focus();
      }
    },
    [lang]
  );
  const day = opened ? shown[opened.index] : null;
  const format = new Intl.DateTimeFormat(
    lang === "ar" ? `ar-SA-u-ca-${calendar}-nu-latn` : `en-GB-u-ca-${calendar}`,
    { day: "numeric", month: "long", weekday: "long" }
  );
  return (
    <li className="border-line border-t py-3.5 first:border-0">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 font-medium">
          {name}
          {degraded ? (
            <span className="arrive inline-flex items-center gap-1 font-medium text-[12px] text-degraded-text">
              <TriangleAlertIcon className="size-3.5" />
              {demo.levels.degraded}
            </span>
          ) : null}
        </span>
        <span className="text-[13px] text-muted">{uptimeOf(shown)}</span>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the handlers only open and close the card of the buttons inside. */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: same. */}
      <div
        className="relative mt-2"
        onBlur={blur}
        onFocus={focus}
        onKeyDown={key}
        onPointerLeave={leave}
        onPointerOver={enter}
      >
        <fieldset
          className={`bar flex min-w-0 gap-0.75 ${shown.length === 90 ? "bar-90 h-6" : "h-9"}`}
        >
          <legend className="sr-only">{name}</legend>
          {shown.map((each, i) => {
            const level =
              degraded && i === shown.length - 1 ? "degraded" : each.level;
            return (
              <button
                aria-expanded={opened?.index === i}
                aria-label={`${format.format(today - (shown.length - 1 - i) * dayMs)}${demo.comma}${demo.levels[level]}`}
                data-cell={level}
                data-index={i}
                // biome-ignore lint/suspicious/noArrayIndexKey: a day's place in the bar is its identity.
                key={i}
                style={{ "--i": i }}
                // One day takes the tab stop, today's or the open one; the arrows move between the rest.
                tabIndex={i === (opened?.index ?? shown.length - 1) ? 0 : -1}
                type="button"
              />
            );
          })}
        </fieldset>
        {day && opened ? (
          <Card place={opened.place}>
            <div className="arrive rounded-lg bg-surface p-3.5 text-[13px] shadow-[0_12px_32px_-16px_oklch(0%_0_0/0.4)] ring-line">
              <div className="flex items-center justify-between">
                <span className="font-medium text-fg">
                  {format.format(
                    today - (shown.length - 1 - opened.index) * dayMs
                  )}
                </span>
                <span className={`font-medium ${levelText[day.level]}`}>
                  {demo.levels[day.level]}
                </span>
              </div>
              <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted">
                <dt>{demo.dayCard.uptime}</dt>
                <dd className="text-end text-fg">{day.uptime.toFixed(2)}%</dd>
                <dt>{demo.dayCard.downtime}</dt>
                <dd className="text-end text-fg">
                  {day.downtime} {demo.dayCard.minutes}
                </dd>
                <dt>{demo.dayCard.response}</dt>
                <dd className="text-end text-fg">
                  {day.response} {demo.dayCard.ms}
                </dd>
              </dl>
              {day.incident ? (
                <p className="mt-2.5 border-line border-t pt-2.5 text-fg">
                  <span className="text-muted">{demo.dayCard.incident}: </span>
                  <span className="underline decoration-line underline-offset-3">
                    {demo.incidentTitle}
                  </span>
                </p>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </li>
  );
}
