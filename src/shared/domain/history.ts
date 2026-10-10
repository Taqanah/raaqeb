/**
 * A status page's history by month:
 * each resolved incident and completed maintenance window belongs to the
 * UTC month it started in. The history reaches from the month of the
 * page's oldest entry, or of the longest day bar's first day when that
 * is earlier, so every day card's month link opens a history month, to the current month, with no cap, since incidents and
 * windows are never purged. Pure: `now` is a parameter.
 */
import { barLengths } from "@/shared/schemas/page.ts";
import type { Month } from "@/shared/schemas/views.ts";
import { utcDayStart } from "./retention.ts";

const dayMs = 86_400_000;

/** The UTC month an instant falls in. */
export function monthOf(ms: number): Month {
  return new Date(ms).toISOString().slice(0, 7);
}

/** The month before or after, by `step`. */
function shift(month: Month, step: number): Month {
  const [year = 0, number = 1] = month.split("-").map(Number);
  return monthOf(Date.UTC(year, number - 1 + step, 1));
}

/** Where a month sits in the history: itself and its neighbours inside the range. */
export interface HistoryMonth {
  readonly month: Month;
  /** Absent at the current month. */
  readonly next: Month | undefined;
  /** Absent at the month of the oldest entry. */
  readonly previous: Month | undefined;
}

/**
 * The month the history shows, the current one when none is named, with
 * its neighbours; nothing for a month outside the range. `starts` are the
 * entries' start times.
 */
export function historyMonth(
  starts: readonly number[],
  month: Month | undefined,
  now: number
): HistoryMonth | undefined {
  const current = monthOf(now);
  // The longest bar any page draws, so no page's day card names a month before the history.
  const bar = monthOf(utcDayStart(now) - (Math.max(...barLengths) - 1) * dayMs);
  const oldest = starts.length > 0 ? monthOf(Math.min(...starts)) : current;
  const first = oldest < bar ? oldest : bar;
  const shown = month ?? current;
  // yyyy-mm sorts as it reads.
  if (shown < first || shown > current) {
    return;
  }
  return {
    month: shown,
    next: shown < current ? shift(shown, 1) : undefined,
    previous: shown > first ? shift(shown, -1) : undefined,
  };
}
