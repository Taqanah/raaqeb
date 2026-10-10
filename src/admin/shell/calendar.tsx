/**
 * The operator's calendar for the admin pages that load no clock of their
 * own (the monitor and component lists' bars); the admin layout reads
 * it with the shell and wraps every page in it.
 */
import { createContext, type ReactNode, useContext } from "react";
import type { Calendar } from "@/shared/schemas/clock.ts";

const OperatorCalendar = createContext<Calendar>("gregorian");

export function OperatorCalendarProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: Calendar;
}): ReactNode {
  return <OperatorCalendar value={value}>{children}</OperatorCalendar>;
}

/** The calendar the operator reads dates in: their own, else the install's. */
export function useOperatorCalendar(): Calendar {
  return useContext(OperatorCalendar);
}
