/**
 * The time zones as the operator reads them: each
 * zone's city in the operator language, from CLDR, then its region's name
 * and its offset from the browser's own Intl, so `Asia/Riyadh` reads
 * «الرياض · التوقيت العربي الرسمي · غرينتش+3». The stored value stays the
 * IANA name. Pure: the time the offsets are read at is a parameter.
 */
import { intlLocale } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { zoneOffsetMs } from "@/shared/i18n/timezone.ts";
import { zoneCities } from "./zone-cities.ts";

/** One zone as the picker lists it. */
export interface ZoneOption {
  /** The city in the operator language; none for a zone named by its offset alone (UTC, Etc/GMT+3). */
  readonly city: string | undefined;
  /** How the field shows it once chosen: the city, or the region, then the offset. */
  readonly label: string;
  /** The offset from GMT in the locale's words: `غرينتش+3`, `GMT+3`. */
  readonly offset: string;
  readonly offsetMinutes: number;
  /** The region's name: `التوقيت العربي الرسمي`, `Arabian Time`. */
  readonly region: string;
  /** The IANA name, which is what is stored. */
  readonly value: string;
}

export function zoneOption(
  zone: string,
  locale: Locale,
  now: number
): ZoneOption {
  const names = zoneCities[zone];
  const city = names ? names[locale === "ar" ? 0 : 1] : undefined;
  const offset = zoneName(zone, locale, now, "shortOffset") ?? zone;
  // A region named only by its offset (Etc/GMT+3) has no name to add; UTC's is in the long form.
  const region =
    [
      zoneName(zone, locale, now, "longGeneric"),
      zoneName(zone, locale, now, "long"),
    ].find((name) => name !== undefined && !digits.test(name)) ?? "";
  const named = city ?? region;
  return {
    city,
    label: named === "" ? offset : `${named} (${offset})`,
    offset,
    offsetMinutes: Math.round(zoneOffsetMs(now, zone) / 60_000),
    region,
    value: zone,
  };
}

const digits = /\d/;

function zoneName(
  zone: string,
  locale: Locale,
  now: number,
  style: Intl.DateTimeFormatOptions["timeZoneName"]
): string | undefined {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: zone,
    timeZoneName: style,
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value;
}

/** The zones from west to east, and by city within one offset. */
export function zoneOptions(
  zones: readonly string[],
  locale: Locale,
  now: number
): readonly ZoneOption[] {
  const collator = new Intl.Collator(intlLocale(locale));
  return zones
    .map((zone) => zoneOption(zone, locale, now))
    .toSorted(
      (a, b) =>
        a.offsetMinutes - b.offsetMinutes ||
        collator.compare(a.city ?? a.label, b.city ?? b.label)
    );
}

/** Whether a search finds the zone: by its city in either language, its region, its offset or its IANA name, Arabic spelled either way. */
export function matchesZone(option: ZoneOption, query: string): boolean {
  const wanted = searchable(query.trim());
  if (wanted === "") {
    return true;
  }
  const names = zoneCities[option.value] ?? [];
  return searchable(
    [...names, option.value, option.region, option.offset].join(" ")
  ).includes(wanted);
}

// Arabic spelled either way: the alef with or without its hamza or madda, a taa marbuta as haa, an alef maqsura as yaa, no short vowels.
const hamzaAlef = /[أإآ]/g;
const shortVowels = /[\u064B-\u0652]/g;

function searchable(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(hamzaAlef, "ا")
    .replaceAll("ة", "ه")
    .replaceAll("ى", "ي")
    .replace(shortVowels, "");
}
