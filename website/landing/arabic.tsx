/**
 * Arabic first: the same page in both languages side by side, the
 * Arabic in front, and today's date in both calendars the install can show,
 * the page's own calendar first.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { Copy } from "~/copy.ts";
import { Section } from "./section.tsx";
import { StatusPage } from "./status-page.tsx";

const day = { day: "numeric", month: "long", year: "numeric" } as const;

export function ArabicFirst({ copy }: { readonly copy: Copy }): ReactNode {
  const a = copy.arabic;
  const [now, setNow] = useState(Date.UTC(2026, 9, 8));
  useEffect(() => {
    setNow(Date.now());
  }, []);
  const tag = copy.locale === "ar" ? "ar-SA" : "en-GB";
  const hijri = [
    new Intl.DateTimeFormat(`${tag}-u-ca-islamic-umalqura-nu-latn`, day).format(
      now
    ),
    a.calendar.hijri,
  ] as const;
  const gregorian = [
    new Intl.DateTimeFormat(`${tag}-u-ca-gregory-nu-latn`, day).format(now),
    a.calendar.gregorian,
  ] as const;
  // Each locale leads with its own calendar: Hijri in Arabic, Gregorian in English.
  const dates = copy.locale === "ar" ? [hijri, gregorian] : [gregorian, hijri];
  return (
    <Section id="arabic" lead={a.lead} title={a.title}>
      <div className="relative mt-16 h-[430px] max-md:h-auto max-md:space-y-4">
        <div className="absolute end-0 top-0 w-[54%] max-md:static max-md:w-auto">
          <div
            className="overflow-hidden rounded-xl shadow-[0_24px_48px_-28px_oklch(0%_0_0/0.35)] ring-line"
            dir="ltr"
          >
            <StatusPage compact lang="en" />
          </div>
        </div>
        <div className="absolute start-0 top-[110px] w-[54%] max-md:static max-md:w-auto">
          <div
            className="overflow-hidden rounded-xl shadow-[0_32px_64px_-28px_oklch(0%_0_0/0.5)] ring-line"
            dir="rtl"
          >
            <StatusPage compact lang="ar" />
          </div>
        </div>
      </div>
      <div className="mt-20 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-16 gap-y-10 border-line border-t pt-10 max-lg:grid-cols-1">
        <p className="max-w-[24em] text-pretty text-[clamp(18px,1.55vw,21px)] leading-[1.6]">
          {a.calendar.text}
        </p>
        <dl className="grid grid-cols-[auto_auto] gap-x-12 gap-y-6 max-sm:grid-cols-1">
          {dates.map(([date, name], n) => (
            <div key={name}>
              <dd
                className={`whitespace-nowrap font-medium text-[clamp(24px,2.3vw,32px)] leading-tight tracking-[-0.02em] ${n ? "text-muted" : ""}`}
              >
                {date}
              </dd>
              <dt className="mt-1.5 text-[14px] text-muted">{name}</dt>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
