/**
 * The "floor broken" banner's rules: an OOM kill, late checks at
 * the fixed count, a 5xx or a dropped connection under load, or RSS still
 * rising in the last quarter of the accelerated day. The capacity sweep is
 * meant to break the container, so it never breaks the floor. A rule a
 * part could not judge is unmeasured, never held ("not captured"
 * is not "no OOM"). The human reads the banner and decides whether the
 * release goes out.
 */
import { lateBoundMs, stillRising } from "./measure.ts";
import type { FloorBreak, RunResult, VariantResult } from "./results.ts";

/** The accelerated day's interval: every checked monitor runs each second. */
export const dayIntervalMs = 1000;

/** Each part's OOM state: killed breaks the floor, not captured leaves it unmeasured. */
function oomBreaks(variant: VariantResult): FloorBreak[] {
  const parts = [
    ["fixed", variant.fixed.oom],
    ["day", variant.day?.oom],
    ["throughput", variant.throughput?.oom],
  ] as const;
  return parts.flatMap(([part, oom]): FloorBreak[] => {
    if (oom === "killed") {
      return [{ kind: "oom", part, variant: variant.variant }];
    }
    return oom === "not-captured"
      ? [{ kind: "unmeasured", part, variant: variant.variant, what: "oom" }]
      : [];
  });
}

/** A minute whose median lateness passed one interval and one tick, in the fixed run and the day; a part with no whole minute is unmeasured. */
function lateBreaks(variant: VariantResult, intervalMs: number): FloorBreak[] {
  const parts = [
    ["fixed", variant.fixed.lateness, intervalMs],
    ...(variant.day
      ? ([["day", variant.day.lateness, dayIntervalMs]] as const)
      : []),
  ] as const;
  return parts.flatMap(([part, minutes, interval]): FloorBreak[] => {
    if (minutes.length === 0) {
      return [
        {
          kind: "unmeasured",
          part,
          variant: variant.variant,
          what: "lateness",
        },
      ];
    }
    const worst = Math.max(...minutes.map((minute) => minute.medianMs));
    return worst > lateBoundMs(interval)
      ? [
          {
            intervalMs: interval,
            kind: "late",
            medianMs: worst,
            part,
            variant: variant.variant,
          },
        ]
      : [];
  });
}

/** A 5xx or a failed connection in the fixed run's load phase; no report from oha is unmeasured. */
function loadBreaks(variant: VariantResult): FloorBreak[] {
  const { load } = variant.fixed;
  if (load === null) {
    return [
      {
        kind: "unmeasured",
        part: "fixed",
        variant: variant.variant,
        what: "load",
      },
    ];
  }
  const errors = Object.values(load.errors).reduce(
    (sum, count) => sum + count,
    0
  );
  return load.serverErrors > 0 || errors > 0
    ? [
        {
          errors,
          kind: "load_errors",
          serverErrors: load.serverErrors,
          variant: variant.variant,
        },
      ]
    : [];
}

/** RSS still rising in the day's last quarter; a quarter with no RSS is unmeasured. */
function dayBreaks(variant: VariantResult): FloorBreak[] {
  const { day } = variant;
  if (!day) {
    return [];
  }
  if (day.quarters.includes(null)) {
    return [
      {
        kind: "unmeasured",
        part: "day",
        variant: variant.variant,
        what: "rss",
      },
    ];
  }
  return stillRising(day.quarters)
    ? [{ kind: "rss_rising", quarters: day.quarters, variant: variant.variant }]
    : [];
}

/** Every reason the run broke the floor, or could not judge it, in the order of its variants and rules; none for a run that held it. */
export function floorBreaks(result: RunResult): FloorBreak[] {
  return result.variants.flatMap((variant) => [
    ...oomBreaks(variant),
    ...lateBreaks(variant, result.flags.intervalSeconds * 1000),
    ...loadBreaks(variant),
    ...dayBreaks(variant),
  ]);
}
