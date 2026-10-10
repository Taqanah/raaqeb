/**
 * Time zones: the install time zone is an IANA name, defaulting to
 * the host's zone. The list and the check come from the runtime's ICU on the
 * server and in the browser alike, so the settings screen offers the same
 * names the server accepts.
 */

let known: ReadonlySet<string> | undefined;

/** Every IANA zone the runtime knows, in ICU's order. */
export function timeZones(): readonly string[] {
  return Intl.supportedValuesOf("timeZone");
}

/** Whether the text names a zone the runtime knows. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  known ??= new Set(timeZones());
  if (known.has(value)) {
    return true;
  }
  // ICU's list omits a few names it still resolves (UTC on some builds); the formatter is the last word.
  try {
    return (
      new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
        .timeZone !== ""
    );
  } catch {
    return false;
  }
}

/** The zone's clock at a time, to the second, as the parts Intl names them. */
function clockParts(
  ms: number,
  timeZone: string
): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of new Intl.DateTimeFormat("en-u-nu-latn-ca-gregory", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(ms)) {
    parts[part.type] = part.value;
  }
  return parts;
}

/** The zone's clock at a time, read as if it were UTC: the time plus the zone's offset then. */
function clockAsUtc(ms: number, timeZone: string): number {
  const { day, hour, minute, month, second, year } = clockParts(ms, timeZone);
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

/** The wall-clock minute a time reads in the zone, as a `datetime-local` field writes it: `2026-09-26T14:30`. */
export function wallTime(ms: number, timeZone: string): string {
  const { day, hour, minute, month, year } = clockParts(ms, timeZone);
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/** A `datetime-local` minute: the date and the time, no seconds. */
const wallMinute = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The time a wall-clock minute in the zone names, from the text a
 * `datetime-local` field writes; nothing for text that is not one. A minute
 * a clock change skips reads at the offset before the change; a minute it
 * repeats reads as the earlier of the two.
 */
export function fromWallTime(
  text: string,
  timeZone: string
): number | undefined {
  const match = wallMinute.exec(text);
  if (!match) {
    return;
  }
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] = match
    .slice(1)
    .map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC rolls 30 February and 24:00 over; a minute that does not exist names no time.
  if (new Date(wall).toISOString().slice(0, 16) !== text) {
    return;
  }
  // The offsets a day either side; a clock change between them makes two readings, or none.
  const dayMs = 86_400_000;
  const before = clockAsUtc(wall - dayMs, timeZone) - (wall - dayMs);
  const after = clockAsUtc(wall + dayMs, timeZone) - (wall + dayMs);
  const readings = [wall - before, wall - after].toSorted((a, b) => a - b);
  // The earlier reading whose clock shows the minute; a skipped minute has none and reads at the offset before the change.
  return (
    readings.find((time) => clockAsUtc(time, timeZone) === wall) ??
    wall - before
  );
}

/** How far the zone's clock is ahead of UTC at a time, in milliseconds. */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  // The clock reads whole seconds, so the offset is taken from the second the time falls in.
  return clockAsUtc(ms, timeZone) - (ms - (ms % 1000));
}

/** The zone the host runs in, which a fresh install uses. */
export function hostTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
