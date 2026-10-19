/**
 * What a WHOIS answer (RFC 3912) says, for the domain registration
 * (CONTEXT.md "Domain registration") of a TLD with no RDAP server. WHOIS is
 * free text that differs by registry, so this reads only two things: the
 * WHOIS server IANA names for a TLD, and an expiry date on a line whose label
 * says so, in a form that reads one way only. A date in any other form is
 * unknown, never a guess. No I/O.
 */

/** What a registry's answer says of the expiry: no expiry line at all (a name it does not hold, or a registry that publishes none), or a line with the date it gave, absent when the date does not read one way only. */
export type WhoisExpiry =
  | { readonly listed: false }
  | { readonly expiresAt: number | undefined; readonly listed: true };

/** What a registry's answer says of the name asked: it holds no such name, or its record of a domain, which may be the name asked or one above it, with the expiry it gave. */
export type WhoisAnswer =
  | { readonly held: false }
  | {
      readonly domain: string | undefined;
      readonly expiresAt: number | undefined;
      readonly held: true;
    };

/** IANA's record of a TLD: its WHOIS server, or none. Nothing when the answer is no record of a TLD, such as a rate limit or an empty reply. */
export function whoisServerOf(
  answer: string
): { readonly server: string | undefined } | undefined {
  if (!ianaRecord.test(answer)) {
    return;
  }
  return { server: referral.exec(answer)?.[1]?.toLowerCase() };
}

const ianaRecord = /^domain:[ \t]*\S/im;
const referral = /^whois:[ \t]*(\S+)/im;

/** The phrases registries answer a name they do not hold with, as captured from them. */
const notFound =
  /no match|not found|no data found|no entries found|no object found|object_not_found|does not exist|bad extension|no matching record/i;
const domainLabel = /^domain(?:[ _]?name)?$/i;
const finalDot = /\.$/;

/** What a registry's answer says of the name asked: a record, or a "not found" it recognises; nothing for anything else (a rate limit, an error, an empty reply), which is no answer at all. */
export function whoisAnswerOf(answer: string): WhoisAnswer | undefined {
  // Some registries echo the name asked above their "not found", so the phrase decides first.
  if (notFound.test(answer)) {
    return { held: false };
  }
  let domain: string | undefined;
  for (const line of answer.split(lineBreak)) {
    const [, label, value] = labelled.exec(line) ?? [];
    if (label !== undefined && value && domainLabel.test(label)) {
      domain = value.toLowerCase().replace(finalDot, "");
      break;
    }
  }
  const expiry = whoisExpiry(answer);
  if (domain === undefined && !expiry.listed) {
    return;
  }
  return {
    domain,
    expiresAt: expiry.listed ? expiry.expiresAt : undefined,
    held: true,
  };
}

/** A label of words, as a registry writes one, then a colon; `%` and `#` start a comment. */
const labelled =
  /^[ \t]*([A-Za-z][A-Za-z .\-_/]{0,59}?)[ \t.]*:[ \t]*(.*?)[ \t]*$/;
const expiryLabel = /expir|paid-till/i;
const lineBreak = /\r?\n/;
const zoneOffset = /^([+-])(\d{2}):?(\d{2})$/;

/** The expiry a registry's answer gives, as UTC milliseconds: the first line whose label names the expiry, read as ISO 8601, `YYYY.MM.DD`, `YYYY/MM/DD`, `YYYYMMDD` or a day with an English month name, at UTC when it names no zone. */
export function whoisExpiry(answer: string): WhoisExpiry {
  for (const line of answer.split(lineBreak)) {
    const [, label, value] = labelled.exec(line) ?? [];
    if (label !== undefined && value !== undefined && expiryLabel.test(label)) {
      return { expiresAt: dateOf(value), listed: true };
    }
  }
  return { listed: false };
}

const yearFirst =
  /^(\d{4})([-./])(\d{2})\2(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?[ \t]*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i;
const compact = /^(\d{4})(\d{2})(\d{2})$/;
const named =
  /^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?[ \t]*(Z|UTC|GMT)?$/i;
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

/** The instant a value names, or nothing when it is not one of the forms that read one way only. */
function dateOf(value: string): number | undefined {
  const iso = yearFirst.exec(value);
  if (iso) {
    const [, year, , month, day, hour, minute, second, zone] = iso;
    return instant(
      [year, month, day, hour, minute, second].map(Number),
      offsetOf(zone)
    );
  }
  const digits = compact.exec(value);
  if (digits) {
    const [, year, month, day] = digits;
    return instant([year, month, day].map(Number), 0);
  }
  const words = named.exec(value);
  const word = words?.[2]?.toLowerCase() ?? "";
  const month = months.findIndex(
    (each) => word.length >= 3 && each.startsWith(word)
  );
  if (words && month !== -1) {
    const [, day, , year, hour, minute, second] = words;
    return instant(
      [Number(year), month + 1, ...[day, hour, minute, second].map(Number)],
      0
    );
  }
}

/** Milliseconds a zone is ahead of UTC; none named is UTC. */
function offsetOf(zone: string | undefined): number {
  const signed = zoneOffset.exec(zone ?? "");
  if (!signed) {
    return 0;
  }
  const [, sign, hours, minutes] = signed;
  return (
    (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000
  );
}

/** The instant of a year, month, day and an optional time at an offset, or nothing when the date is not on the calendar. */
function instant(
  parts: readonly number[],
  offsetMs: number
): number | undefined {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] =
    parts.map((each) => (Number.isNaN(each) ? 0 : each));
  const at = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC rolls 30 February, or a day 0 or 32, into another month; a date that moved was not one.
  if (
    new Date(at).getUTCMonth() !== month - 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return;
  }
  return at - offsetMs;
}
