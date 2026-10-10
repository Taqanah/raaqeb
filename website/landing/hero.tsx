/**
 * The hero, Workbench with E1: the claim and the install command on
 * the start side, the live status page on the end side running past the
 * page's edge, as there is more product than fits. A heartbeat runs under it
 * and the checks it is made of stream in at its corner. One orchestrated
 * reveal: the words rise in turn, the page settles last and its bars grow.
 */
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { Locale } from "@/shared/i18n/locale.ts";
import { CheckIcon, TriangleAlertIcon, XIcon } from "@/shared/ui/icons.tsx";
import { type Copy, docsPath, installCommand } from "~/copy.ts";
import { type Brand, Logo } from "./logos.tsx";
import { CodeLine } from "./section.tsx";
import { StatusPage } from "./status-page.tsx";

const step = (i: number): CSSProperties => ({ "--i": i });

/** One beat of the trace at `x`, on a 1200-wide line resting at 70. */
function beat(x: number): string {
  return [
    [x, 70],
    [x + 14, 70],
    [x + 22, 58],
    [x + 30, 70],
    [x + 44, 70],
    [x + 52, 18],
    [x + 62, 116],
    [x + 72, 70],
    [x + 90, 70],
    [x + 102, 52],
    [x + 118, 70],
  ]
    .map(([px, py]) => `L${px},${py}`)
    .join(" ");
}
const trace = `M0,70 ${[60, 360, 660, 960].map(beat).join(" ")} L1200,70`;

/** The checks the stream runs through, round and round: which of the sample's monitors, its time in ms and how it went. */
const checks = [
  ["storefront", 142, "up"],
  ["database", 9, "up"],
  ["payments", 812, "degraded"],
  ["email", 23, "up"],
  ["app", 64, "up"],
  ["payments", 2104, "down"],
  ["email", 21, "up"],
] as const;

/** A check's mark and the colour of its time, by how it went. */
const outcome = {
  degraded: [
    <TriangleAlertIcon className="size-3.5 text-degraded" key="mark" />,
    "text-degraded-text",
  ],
  down: [
    <XIcon className="size-3.5 text-down" key="mark" strokeWidth={2.5} />,
    "text-down-text",
  ],
  up: [
    <CheckIcon className="size-3.5 text-up" key="mark" strokeWidth={2.5} />,
    "text-fg",
  ],
} as const;
type Monitor = (typeof checks)[number][0];
const rows = 5;

export function Hero({
  copy,
  locale,
}: {
  readonly copy: Copy;
  readonly locale: Locale;
}): ReactNode {
  const [before, after] = copy.hero.title.split(copy.hero.accent);
  return (
    <div className="relative overflow-x-clip">
      <svg
        aria-hidden="true"
        className="ecg mirror absolute bottom-20 left-0 h-[140px] w-full text-teal max-lg:bottom-0"
        preserveAspectRatio="none"
        viewBox="0 0 1200 140"
      >
        <path className="base" d={trace} />
        <path className="beam" d={trace} pathLength="1000" />
      </svg>
      <div className="relative mx-auto grid max-w-[1200px] grid-cols-[minmax(33rem,1fr)_1.35fr] items-center gap-x-16 px-6 pt-28 pb-56 max-lg:grid-cols-1 max-lg:gap-y-14 max-lg:pt-24 max-lg:pb-28">
        <div>
          <h1
            className="rise max-w-[11em] text-balance font-medium text-[clamp(40px,4.6vw,64px)] leading-[1.02] tracking-[-0.035em] [overflow-wrap:anywhere] [&:lang(ar)]:text-[clamp(38px,4.2vw,58px)]"
            style={step(0)}
          >
            {before}
            <span className="text-teal-text">{copy.hero.accent}</span>
            {after}
          </h1>
          <p
            className="rise mt-6 max-w-[32em] text-pretty text-[19px] leading-[1.6]"
            style={step(1)}
          >
            {copy.hero.lead}
          </p>
          <div
            className="rise mt-8 flex flex-wrap items-center gap-x-6 gap-y-3"
            style={step(2)}
          >
            <a
              className="inline-flex h-11 items-center whitespace-nowrap rounded-lg bg-action px-5 font-medium text-[15px] text-action-fg transition-transform hover:-translate-y-px active:translate-y-0"
              href="#start"
            >
              {copy.hero.install}
            </a>
            <a
              className="whitespace-nowrap font-medium text-[15px] text-muted transition-colors hover:text-fg"
              href={docsPath[locale]}
            >
              {copy.hero.docs}{" "}
              <span aria-hidden="true">{locale === "ar" ? "←" : "→"}</span>
            </a>
          </div>
          <div className="rise mt-10 max-w-[36rem]" style={step(3)}>
            <CodeLine
              code={installCommand}
              copied={copy.command.copied}
              copy={copy.command.copy}
            />
            <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted leading-none">
              <span className="text-faint">{copy.command.runsOn}</span>
              <Platform brand="linux" name="Linux" />
              <Platform brand="apple" name="macOS" />
              <span>Windows</span>
              <Platform brand="docker" name="Docker" />
            </p>
          </div>
        </div>
        <div className="relative">
          <div className="settle me-[-12vw] max-lg:me-0">
            <StatusPage
              bare
              className="overflow-hidden rounded-xl shadow-[0_24px_64px_-32px_oklch(0%_0_0/0.35)] ring-line"
              lang={locale}
            />
          </div>
          <Stream
            names={{
              app: copy.demo.components[2],
              database: copy.demo.grouped[0],
              email: copy.demo.components[3],
              payments: copy.demo.components[1],
              storefront: copy.demo.components[0],
            }}
            title={copy.checks.detail.recent}
            unit={copy.demo.dayCard.ms}
          />
        </div>
      </div>
    </div>
  );
}

/** The checks behind the page as they run: a new one slides in at the top every beat or so. */
function Stream({
  names,
  title,
  unit,
}: {
  readonly names: Readonly<Record<Monitor, string>>;
  readonly title: string;
  readonly unit: string;
}): ReactNode {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const timer = setInterval(() => setN((k) => k + 1), 1600);
    return () => clearInterval(timer);
  }, []);
  // Fixed columns, so a wider name or time arriving never shifts the rest. Newest first, one more than shows, so the oldest leaves out of sight; a row's number is its place in the endless run, so React keeps the old rows and adds the new.
  const shown = Array.from({ length: rows + 1 }, (_, k) => n + rows - k);
  return (
    <div
      aria-hidden="true"
      className="drop absolute start-[-3.5rem] -bottom-36 w-[22rem] overflow-hidden rounded-xl bg-surface shadow-[0_24px_48px_-24px_oklch(0%_0_0/0.4)] ring-line max-lg:hidden"
    >
      <div className="flex items-center gap-2.5 px-4 py-3 text-[13px]">
        <span className="live size-2 rounded-full bg-up" />
        <span className="font-medium">{title}</span>
      </div>
      <ul className="stream grid h-[180px] grid-cols-[0.5rem_14px_minmax(0,1fr)_4rem_0.5rem] content-start gap-x-2 overflow-hidden text-[13px] [:lang(ar)_&]:grid-cols-[0.5rem_14px_minmax(0,1fr)_6.5rem_0.5rem]">
        {shown.map((i) => {
          const [monitor, ms, level] = checks[i % checks.length] ?? checks[0];
          const [mark, timeTone] = outcome[level];
          // A time that drifts a little from one check to the next.
          const took = Math.max(
            1,
            Math.round(ms * (1 + (((i * 7) % 9) - 4) / 20))
          );
          return (
            <li
              className={`col-span-5 grid h-9 grid-cols-subgrid items-center overflow-hidden border-line-2 border-t ${i > rows ? "slot" : ""}`}
              key={i}
            >
              {/* The first and last tracks are the row's side padding, so its hairline runs the full width. */}
              <span className="col-start-2 flex">{mark}</span>
              <span className="truncate text-fg">{names[monitor]}</span>
              <span
                className={`whitespace-nowrap text-end tabular-nums ${timeTone}`}
              >
                {took}
                <span className="ms-1 text-[12px] text-faint">{unit}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Platform({
  brand,
  name,
}: {
  readonly brand: Brand;
  readonly name: string;
}): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5">
      {/* The marks sit on the middle of the capitals, not of the line box, which Rubik's overrides set low. */}
      <Logo brand={brand} className="size-3.5 -translate-y-[1.5px]" />
      {name}
    </span>
  );
}
