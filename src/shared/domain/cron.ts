/**
 * The cron grammar a heartbeat monitor's schedule accepts: Bun's own, five fields or a
 * nickname, which the server reads with `Bun.cron.parse`. That parser does not exist in the browser, so
 * the form's refusal comes from this check of the same grammar; the server
 * refuses what Bun refuses, and what parses but never fires, so the form
 * marks the field itself. Where Bun is lenient (`+1`, `000`) this check is
 * stricter, never the other way.
 */

const nickname = /^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/i;
const number = /^\d{1,2}$/;
const step = /^\d{1,3}$/;
const stepMax = 127;
// Spaces and tabs only: Bun reads a no-break space as part of a field.
const blanks = /[ \t]+/;

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

interface Field {
  readonly max: number;
  readonly min: number;
  /** Names for the values from `min`, as a whole word or its first three letters. */
  readonly names?: readonly string[];
}

// Minute, hour, day of month, month, day of week (0 and 7 are both Sunday).
const fields: readonly Field[] = [
  { max: 59, min: 0 },
  { max: 23, min: 0 },
  { max: 31, min: 1 },
  { max: 12, min: 1, names: months },
  { max: 7, min: 0, names: weekdays },
];

/** A value of the field as a number, or nothing when it is not one. */
function numberOf(text: string, field: Field): number | undefined {
  const lower = text.toLowerCase();
  const named = field.names?.findIndex(
    (name) => name === lower || name.slice(0, 3) === lower
  );
  const value =
    named !== undefined && named >= 0
      ? field.min + named
      : number.test(text) && Number(text);
  return typeof value === "number" && value >= field.min && value <= field.max
    ? value
    : undefined;
}

/** The values one comma-separated item stands for: `*`, a value or a range, with an optional step from 1 to 127 (Bun's limit); nothing when it is not one. */
function itemValues(text: string, field: Field): number[] | undefined {
  const [base = "", every, extra] = text.split("/");
  if (extra !== undefined) {
    return;
  }
  if (
    every !== undefined &&
    !(step.test(every) && Number(every) >= 1 && Number(every) <= stepMax)
  ) {
    return;
  }
  let start = field.min;
  let end = field.max;
  if (base !== "*") {
    const [from = "", to, more] = base.split("-");
    const first = numberOf(from, field);
    const last = to === undefined ? first : numberOf(to, field);
    if (
      more !== undefined ||
      first === undefined ||
      last === undefined ||
      first > last
    ) {
      return;
    }
    start = first;
    // A value with a step runs to the field's end, as Bun reads `5/10`.
    end = to === undefined && every !== undefined ? field.max : last;
  }
  const values: number[] = [];
  for (let value = start; value <= end; value += Number(every ?? 1)) {
    values.push(value);
  }
  return values;
}

/** The values a field stands for, or nothing when one of its items is not one. */
function fieldValues(text: string, field: Field): Set<number> | undefined {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const found = itemValues(item, field);
    if (!found) {
      return;
    }
    for (const value of found) {
      values.add(value);
    }
  }
  return values;
}

/** The longest each month runs; February's 29th comes within Bun's eight-year search. */
const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Whether a day of the month and a month ever meet. A day-of-week field other than `*` adds days of its own, so only a bare `*` leaves the day of the month alone (Bun reads the two as either-or). */
function fires(
  onDays: Set<number>,
  inMonths: Set<number>,
  weekday: string
): boolean {
  if (weekday !== "*") {
    return true;
  }
  return [...inMonths].some((month) =>
    [...onDays].some((day) => day <= (monthDays[month - 1] ?? 0))
  );
}

/** Whether the text is five cron fields or a nickname as `Bun.cron.parse` reads them, and fires at least once: a day no month has (30 February) is refused. */
export function isCronExpression(text: string): boolean {
  const trimmed = text.trim();
  if (nickname.test(trimmed)) {
    return true;
  }
  const parts = trimmed.split(blanks);
  if (parts.length !== fields.length) {
    return false;
  }
  const sets = parts.map((part, index) => {
    const field = fields[index];
    return field && fieldValues(part, field);
  });
  const [, , onDays, inMonths] = sets;
  return (
    sets.every((set) => set !== undefined) &&
    onDays !== undefined &&
    inMonths !== undefined &&
    fires(onDays, inMonths, parts[4] ?? "")
  );
}
