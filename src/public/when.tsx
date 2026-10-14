/**
 * Times as a visitor reads them: the server writes the
 * absolute time in the install's calendar, clock and zone with its label, and after
 * mount the browser shows its own zone, relative under a day in either
 * direction, so hydration sees the server's markup unchanged (ADR-0006).
 * The absolute form stays on hover.
 */
import { type ReactNode, useEffect, useState } from "react";
import { formatDateTimeWithZone, relativeTime } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Calendar, Clock } from "@/shared/schemas/clock.ts";

/** The visitor's zone and the time now, read after mount and every minute; nothing on the server's pass. */
export interface VisitorClock {
  readonly now: number;
  readonly timeZone: string;
}

export function useVisitorClock(): VisitorClock | undefined {
  const [visitor, setVisitor] = useState<VisitorClock>();
  useEffect(() => {
    const read = () =>
      setVisitor({
        now: Date.now(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, []);
  return visitor;
}

/** How a view writes its times: the install's calendar, clock and zone, and the visitor's once known. */
export interface TimeContext {
  readonly calendar: Calendar;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly visitor: VisitorClock | undefined;
}

export function When({
  at,
  relative = false,
  time,
}: {
  /** An ISO 8601 time from the view's document. */
  readonly at: string;
  /** Whether to show it relative to now under a day once mounted. */
  readonly relative?: boolean;
  readonly time: TimeContext;
}): ReactNode {
  const { locale } = useMessages();
  const ms = Date.parse(at);
  const zone = time.visitor?.timeZone ?? time.timeZone;
  const absolute = heldTogether(
    formatDateTimeWithZone(locale, ms, {
      calendar: time.calendar,
      clock: time.clock,
      timeZone: zone,
    })
  );
  const shown =
    relative && time.visitor
      ? (relativeTime(locale, ms, time.visitor.now) ?? absolute)
      : absolute;
  return (
    <time dateTime={at} title={absolute}>
      {shown}
    </time>
  );
}

/** The time and zone after the date's last comma joined by no-break spaces, so a narrow screen wraps the date and never leaves the zone or the time's half of the day alone on a line. */
function heldTogether(text: string): string {
  const cut = Math.max(text.lastIndexOf(", "), text.lastIndexOf("، ")) + 2;
  return cut < 2
    ? text
    : text.slice(0, cut) + text.slice(cut).replaceAll(" ", "\u00A0");
}
