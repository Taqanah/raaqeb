/**
 * A bar of UTC days (CONTEXT.md "Day bar"), one cell per
 * day, oldest first, coloured in steps by the day's uptime: a component's on
 * a status page and in the admin's component list, a monitor's in the
 * admin's list and on its detail. Over 30 days a phone shows the last 30, a
 * tablet 60 and a wider screen the whole bar, by CSS alone, and the caption
 * and the uptime follow the days shown. A cell opens its day's card: the
 * status word, the date, the uptime, the downtime, the mean response time,
 * and the incidents and maintenance windows that ran on it, each a link the
 * caller draws, then the footer the caller draws. Hover or focus opens it
 * on a desktop and a tap on a phone, where it spans the bar with a close
 * button; leaving the bar, Escape, a tap outside or a scroll closes it. The
 * card sits in the top layer, placed from its cell, so no frame around the
 * bar clips it. The arrow keys move between days. Cells sit in the reading
 * direction, so in Arabic today is at the left edge.
 */
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { barSpans, cellLevel, lastDaysUptime } from "@/shared/domain/bar.ts";
import {
  formatDay,
  formatDaysAgo,
  formatDuration,
  formatUnit,
  formatUptime,
} from "@/shared/i18n/format.ts";
import { directionOf } from "@/shared/i18n/locale.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Calendar } from "@/shared/schemas/clock.ts";
import type { OverviewDay, OverviewNotice } from "@/shared/schemas/overview.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import { cn } from "./cn.ts";
import { TriangleAlertIcon, WrenchIcon, XIcon } from "./icons.tsx";
import { levelWords, StatusLevelBadge } from "./status-level.tsx";

/** A cell's colour as a word with no underscore: Tailwind reads an underscore in an arbitrary variant as a space, which dropped these rules once (the screenshot run). */
const cellWords: Readonly<Record<StatusLevel, string>> = {
  degraded_performance: "degraded",
  major_outage: "down",
  operational: "up",
  partial_outage: "partial",
  under_maintenance: "maintenance",
};

/** Every cell's look is set once on the bar, by its colour word, so up to 90 cells times each component stay small in the page's HTML; square corners. */
const cells =
  "[&>button]:min-w-0 [&>button]:flex-1 [&>button]:bg-subtle [&>button]:outline-none [&>button]:transition-opacity [&>button:hover]:opacity-70 [&>button[aria-expanded=true]]:opacity-70 [&>button:focus-visible]:ring-2 [&>button:focus-visible]:ring-ring [&>[data-cell=degraded]]:bg-status-degraded [&>[data-cell=down]]:bg-status-down [&>[data-cell=up]]:bg-status-up [&>[data-cell=partial]]:bg-status-partial";

/** Where each span of `barSpans` shows, by its place: from which width on, and up to which. */
const spanFrom = ["", "max-md:hidden", "max-lg:hidden"] as const;
const spanUntil = ["md:hidden", "lg:hidden", ""] as const;

/** The classes that show the span at `place` of a bar's `count` spans at its own widths alone. */
export function spanShown(place: number, count: number): string {
  return cn(spanFrom[place], place < count - 1 && spanUntil[place]);
}

/** The width from which the card floats beside its cell; below it the card spans the bar. */
export const floatingFrom = "(min-width: 48rem)";

/** A floating card's width in pixels, `w-72`. */
const cardWidth = 288;

/** The cell an event came from, if any. */
function cellOf(target: EventTarget): HTMLElement | null {
  return target instanceof HTMLElement
    ? target.closest<HTMLElement>("[data-index]")
    : null;
}

/** The open day: its place in the bar, whether its card floats, and where the card sits on the screen. */
interface Opened {
  readonly floating: boolean;
  readonly index: number;
  readonly place: CSSProperties;
}

/** What a notice in a day's card links to; the caller draws the link. */
export type NoticeKind = "incidents" | "maintenance";

/** Where a card goes for a cell in a bar: under the bar, or over it in the screen's lower part, centred on the cell while floating. */
export function placeOf(
  cell: DOMRect,
  bar: DOMRect,
  floating: boolean
): CSSProperties {
  const width = floating ? cardWidth : bar.width;
  const left = floating
    ? Math.min(
        Math.max(cell.left + cell.width / 2 - width / 2, 8),
        window.innerWidth - width - 8
      )
    : bar.left;
  const below = bar.bottom < window.innerHeight * 0.6;
  // Physical pixels from the cell's box; the card's padding bridges the gap to the bar, so the pointer never leaves.
  // Each edge on its own: React sets the keys in order, and an `inset` after `bottom` reset it.
  return below
    ? {
        bottom: "auto",
        left,
        paddingTop: 8,
        right: "auto",
        top: bar.bottom,
        width,
      }
    : {
        bottom: window.innerHeight - bar.top,
        left,
        paddingBottom: 8,
        right: "auto",
        top: "auto",
        width,
      };
}

export function UptimeBar<Day extends OverviewDay>({
  calendar,
  caption = true,
  className,
  days,
  footer,
  labels = {},
  notice,
  percentages,
}: {
  /** The calendar the days' dates are written in. */
  readonly calendar: Calendar;
  /** Whether the bar has its caption under it: how far it reaches, its uptime and today. */
  readonly caption?: boolean;
  /** The cells' height, `[&>button]:h-8` unless given. */
  readonly className?: string;
  readonly days: readonly Day[];
  /** What a day's card ends with, drawn by the caller, with what closes the card; nothing unless given. */
  readonly footer?: (day: Day, close: () => void) => ReactNode;
  /** A page's own names for the status levels in this locale. */
  readonly labels?: Partial<Record<StatusLevel, string>>;
  /** The link a notice in a day's card opens, drawn by the caller. */
  readonly notice: (kind: NoticeKind, notice: OverviewNotice) => ReactNode;
  /** Whether the caption shows uptime figures. */
  readonly percentages: boolean;
}): ReactNode {
  const { locale, t } = useMessages();
  const rtl = directionOf(locale) === "rtl";
  const [opened, setOpened] = useState<Opened | undefined>();
  const area = useRef<HTMLDivElement>(null);
  const cardId = useId();
  const spans = barSpans(days.length);

  // A tap anywhere else closes the card; read only while it is open.
  useEffect(() => {
    if (!opened) {
      return;
    }
    const close = (event: globalThis.PointerEvent) => {
      if (
        !(event.target instanceof Node && area.current?.contains(event.target))
      ) {
        setOpened(undefined);
      }
    };
    // A placed card would drift from its cell, so a scroll or a resize closes it.
    const drop = () => setOpened(undefined);
    document.addEventListener("pointerdown", close);
    window.addEventListener("scroll", drop, { capture: true, passive: true });
    window.addEventListener("resize", drop);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", drop, { capture: true });
      window.removeEventListener("resize", drop);
    };
  }, [opened]);

  const open = useCallback((target: EventTarget) => {
    const cell = cellOf(target);
    const row = cell?.parentElement;
    if (!(cell && row)) {
      return;
    }
    const floating = window.matchMedia(floatingFrom).matches;
    setOpened({
      floating,
      index: Number(cell.dataset.index),
      place: placeOf(
        cell.getBoundingClientRect(),
        row.getBoundingClientRect(),
        floating
      ),
    });
  }, []);

  const close = useCallback(() => setOpened(undefined), []);

  const onOpen = useCallback(
    (event: SyntheticEvent<HTMLDivElement>) => open(event.target),
    [open]
  );

  const onPointerOver = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse") {
        open(event.target);
      }
    },
    [open]
  );

  const onPointerLeave = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") {
      setOpened(undefined);
    }
  }, []);

  const onBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget;
    if (!(to instanceof Node && event.currentTarget.contains(to))) {
      setOpened(undefined);
    }
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        setOpened(undefined);
        return;
      }
      // Time runs in the reading direction, so the arrow toward the end of the line is the next day.
      const forward = rtl ? "ArrowLeft" : "ArrowRight";
      const back = rtl ? "ArrowRight" : "ArrowLeft";
      const cell = cellOf(event.target);
      if (!(cell && (event.key === forward || event.key === back))) {
        return;
      }
      const index =
        Number(cell.dataset.index) + (event.key === forward ? 1 : -1);
      const next = event.currentTarget.querySelector<HTMLElement>(
        `[data-index="${index}"]`
      );
      // A day this screen hides is never reached.
      if (next?.checkVisibility()) {
        event.preventDefault();
        next.focus();
      }
    },
    [rtl]
  );

  const day = opened ? days[opened.index] : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the events come from the cells inside, each a button */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: as above */}
      <div
        className="relative"
        onBlur={onBlur}
        onClick={onOpen}
        onFocus={onOpen}
        onKeyDown={onKeyDown}
        onPointerLeave={onPointerLeave}
        onPointerOver={onPointerOver}
        ref={area}
      >
        <fieldset
          className={cn(
            "flex min-w-0 gap-0.5",
            cells,
            className ?? "[&>button]:h-8"
          )}
          data-slot="uptime-bar"
        >
          <legend className="sr-only">{t("public_bar")}</legend>
          {days.map((each, index) => {
            const level = cellLevel(each.uptime);
            const age = days.length - 1 - index;
            const span = spans.findIndex((count) => age < count);
            const current = opened?.index === index;
            return (
              <button
                aria-describedby={current ? cardId : undefined}
                aria-expanded={current}
                aria-label={t("public_day_cell", {
                  date: formatDay(locale, Date.parse(each.date), calendar),
                  status: level
                    ? (labels[level] ?? t(levelWords[level]))
                    : t("public_day_no_data"),
                })}
                className={spanFrom[span]}
                data-cell={level ? cellWords[level] : "none"}
                data-index={index}
                data-level={level ?? "none"}
                key={each.date}
                // One cell takes the tab stop, today's or the open one; the arrows move between the rest.
                tabIndex={index === (opened?.index ?? days.length - 1) ? 0 : -1}
                type="button"
              />
            );
          })}
        </fieldset>
        {day && opened ? (
          <DayCard
            calendar={calendar}
            day={day}
            floating={opened.floating}
            footer={footer}
            id={cardId}
            labels={labels}
            notice={notice}
            onClose={close}
            place={opened.place}
          />
        ) : null}
      </div>
      {(caption ? spans : []).map((count, place) => {
        const uptime = percentages ? lastDaysUptime(days, count) : undefined;
        return (
          <div
            className={cn(
              "flex items-center justify-between gap-2 text-muted-foreground text-xs tabular-nums",
              spanShown(place, spans.length)
            )}
            data-days={count}
            data-slot="bar-caption"
            key={count}
          >
            <span>{formatDaysAgo(locale, count)}</span>
            {uptime ? (
              <span data-slot="uptime-figure">
                {t("public_uptime", { uptime: formatUptime(locale, uptime) })}
              </span>
            ) : null}
            <span>{formatDaysAgo(locale, 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One day's card in the top layer: floating from the width set by `floatingFrom`, the bar's width below it. */
function DayCard<Day extends OverviewDay>({
  calendar,
  day,
  floating,
  footer,
  id,
  labels,
  notice,
  onClose,
  place,
}: {
  readonly calendar: Calendar;
  readonly day: Day;
  readonly floating: boolean;
  readonly footer: ((day: Day, close: () => void) => ReactNode) | undefined;
  readonly id: string;
  readonly labels: Partial<Record<StatusLevel, string>>;
  readonly notice: (kind: NoticeKind, notice: OverviewNotice) => ReactNode;
  readonly onClose: () => void;
  readonly place: CSSProperties;
}): ReactNode {
  const { locale, t } = useMessages();
  const level = cellLevel(day.uptime);
  // A caller with nothing to say for this day draws no footer, so no rule ends the card.
  const end = footer?.(day, onClose);
  const card = useRef<HTMLDivElement>(null);
  // Shown in the top layer once mounted, so no frame or scroll box around the bar clips it.
  useEffect(() => {
    card.current?.showPopover();
  }, []);
  return (
    <div
      className="m-0 overflow-visible border-0 bg-transparent p-0"
      data-slot="day-card"
      id={id}
      popover="manual"
      ref={card}
      style={place}
    >
      <div className="flex flex-col gap-2 rounded-lg bg-popover p-3 text-popover-foreground text-sm shadow-md ring-(--rim) ring-1">
        <div className="flex items-center gap-2">
          {level ? (
            <StatusLevelBadge label={labels[level]} level={level} />
          ) : (
            <span className="font-medium">{t("public_day_no_data")}</span>
          )}
          <span className="me-auto text-muted-foreground text-xs">
            {formatDay(locale, Date.parse(day.date), calendar)}
          </span>
          {floating ? null : (
            <button
              aria-label={t("public_day_close")}
              className="-m-1 rounded-sm p-1 text-muted-foreground hover:text-foreground"
              onClick={onClose}
              type="button"
            >
              <XIcon className="size-4" />
            </button>
          )}
        </div>
        {day.uptime ? (
          <div className="flex flex-col gap-0.5 text-xs tabular-nums">
            <span>
              {t("public_uptime", { uptime: formatUptime(locale, day.uptime) })}
            </span>
            <span className="text-muted-foreground">
              {/* Under a second of downtime would read "0 sec" beside an uptime under 100%. */}
              {day.downtimeMs >= 1000
                ? t("public_day_downtime", {
                    duration: formatDuration(locale, day.downtimeMs),
                  })
                : t("public_day_no_downtime")}
            </span>
            {day.responseMs === null ? null : (
              <span className="text-muted-foreground">
                {t("public_day_response", {
                  duration: formatUnit(locale, day.responseMs, "millisecond"),
                })}
              </span>
            )}
          </div>
        ) : null}
        {day.incidents.length + day.maintenance.length > 0 ? (
          <ul className="flex flex-col gap-1.5 border-border border-t pt-2 text-xs">
            {day.incidents.map((each) => (
              <Notice
                key={each.id}
                kind="incidents"
                link={notice("incidents", each)}
              />
            ))}
            {day.maintenance.map((each) => (
              <Notice
                key={each.id}
                kind="maintenance"
                link={notice("maintenance", each)}
              />
            ))}
          </ul>
        ) : null}
        {end ? (
          <div className="border-border border-t pt-2 text-xs">{end}</div>
        ) : null}
      </div>
    </div>
  );
}

function Notice({
  kind,
  link,
}: {
  readonly kind: NoticeKind;
  readonly link: ReactNode;
}): ReactNode {
  const { t } = useMessages();
  const Icon = kind === "incidents" ? TriangleAlertIcon : WrenchIcon;
  return (
    <li className="flex items-start gap-1.5">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          kind === "incidents"
            ? "text-status-partial"
            : "text-status-maintenance"
        )}
      />
      <span className="sr-only">
        {t(kind === "incidents" ? "public_incident" : "public_maintenance")}
      </span>
      {link}
    </li>
  );
}
