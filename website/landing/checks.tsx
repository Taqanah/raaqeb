/**
 * What it watches: the check types, each with its mark, driving the
 * monitor's own page beside them; the response line draws once when the
 * section comes into view.
 */
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useId,
  useState,
} from "react";
import {
  CheckIcon,
  DatabaseIcon,
  TriangleAlertIcon,
  XIcon,
} from "@/shared/ui/icons.tsx";
import type { CheckKind, Copy } from "~/copy.ts";
import { GlobeIcon, HeartPulseIcon, NetworkIcon, PlugIcon } from "./icons.tsx";
import { Logo } from "./logos.tsx";
import { chosenValue, Frame, Section, useSeen } from "./section.tsx";

const kinds: readonly CheckKind[] = [
  "http",
  "tcp",
  "dns",
  "database",
  "docker",
  "heartbeat",
];

/** Each check type's mark: a plain glyph, or the product's own logo where it has one. */
const marks: Readonly<Record<CheckKind, ReactNode>> = {
  database: <DatabaseIcon />,
  dns: <NetworkIcon />,
  docker: <Logo brand="docker" />,
  heartbeat: <HeartPulseIcon />,
  http: <GlobeIcon />,
  tcp: <PlugIcon />,
};

type State = "up" | "degraded" | "down";

/** Each type's sample monitor as it stands: its state, its uptime over 24 hours, 7, 30 and 90 days, its recent checks (time, state, ms) and the slow or failed checks on its day's line. */
const monitors: Readonly<
  Record<
    CheckKind,
    {
      readonly state: State;
      readonly uptimes: readonly [string, string, string, string];
      readonly recent: readonly (readonly [string, State, number | null])[];
      readonly spikes: Readonly<Record<number, State>>;
    }
  >
> = {
  database: {
    spikes: { 22: "degraded", 45: "degraded", 46: "degraded", 47: "degraded" },
    recent: [
      ["14:12:40", "degraded", 1412],
      ["14:12:20", "degraded", 1288],
      ["14:12:00", "up", 11],
      ["14:11:40", "up", 9],
    ],
    state: "degraded",
    uptimes: ["99.40%", "99.88%", "99.93%", "99.96%"],
  },
  dns: {
    spikes: { 20: "degraded" },
    recent: [
      ["14:12:40", "up", 23],
      ["14:12:20", "up", 21],
      ["14:12:00", "up", 25],
      ["14:11:40", "up", 22],
    ],
    state: "up",
    uptimes: ["100%", "99.99%", "99.97%", "99.93%"],
  },
  docker: {
    spikes: { 28: "down", 29: "down" },
    recent: [
      ["14:12:40", "up", 4],
      ["14:12:20", "up", 3],
      ["14:12:00", "up", 4],
      ["14:11:40", "up", 5],
    ],
    state: "up",
    uptimes: ["100%", "99.97%", "99.95%", "99.91%"],
  },
  heartbeat: {
    spikes: { 46: "down", 47: "down" },
    recent: [
      ["03:00", "down", null],
      ["03:00", "up", null],
      ["03:01", "up", null],
      ["03:00", "up", null],
    ],
    state: "down",
    uptimes: ["95.83%", "99.40%", "99.86%", "99.95%"],
  },
  http: {
    spikes: { 12: "degraded", 33: "degraded", 40: "down" },
    recent: [
      ["14:12:40", "up", 138],
      ["14:12:20", "degraded", 812],
      ["14:12:00", "down", 2104],
      ["14:11:40", "up", 129],
    ],
    state: "up",
    uptimes: ["99.98%", "99.91%", "99.84%", "99.72%"],
  },
  tcp: {
    spikes: { 44: "down", 45: "down", 46: "down", 47: "down" },
    recent: [
      ["14:12:40", "down", 3],
      ["14:12:20", "down", 2],
      ["14:12:00", "up", 6],
      ["14:11:40", "up", 5],
    ],
    state: "down",
    uptimes: ["98.62%", "99.71%", "99.90%", "99.95%"],
  },
};

/** How high a slow or failed check rises over the line. */
const rise: Readonly<Record<State, number>> = { degraded: 55, down: 95, up: 0 };

const x = (i: number) => ((i / 47) * 600).toFixed(1);

/** The day's line for a monitor, and its slow and failed stretches drawn over it in their colours. */
function lineOf(spikes: Readonly<Record<number, State>>): {
  readonly line: string;
  readonly stretches: readonly (readonly [State, string])[];
} {
  const y = Array.from(
    { length: 48 },
    (_, i) =>
      150 -
      (50 +
        16 * Math.sin(i / 3) +
        9 * Math.sin(i * 1.7) +
        rise[spikes[i] ?? "up"])
  );
  const at = (i: number) => `${x(i)},${(y[i] ?? 150).toFixed(1)}`;
  const line = y.map((_, i) => `${i ? "L" : "M"}${at(i)}`).join(" ");
  // Each marked check colours the two segments that meet at it.
  const stretches = Object.entries(spikes).map(([key, state]) => {
    const i = Number(key);
    const from = Math.max(0, i - 1);
    const to = Math.min(47, i + 1);
    return [state, `M${at(from)} L${at(i)} L${at(to)}`] as const;
  });
  return { line, stretches };
}

/** A check's mark and colour by how it went. */
const outcome: Readonly<Record<State, readonly [ReactNode, string]>> = {
  degraded: [
    <TriangleAlertIcon className="size-3.5" key="mark" />,
    "text-degraded-text",
  ],
  down: [
    <XIcon className="size-3.5" key="mark" strokeWidth={3} />,
    "text-down-text",
  ],
  up: [
    <CheckIcon className="size-3.5" key="mark" strokeWidth={3} />,
    "text-up-text",
  ],
};

/** A stretch's stroke by how the checks in it went. */
const stroke: Readonly<Record<State, string>> = {
  degraded: "stroke-degraded",
  down: "stroke-down",
  up: "stroke-teal",
};

export function Checks({ copy }: { readonly copy: Copy }): ReactNode {
  const [kind, setKind] = useState<CheckKind>("http");
  const [ref, seen] = useSeen();
  const name = useId();
  const c = copy.checks;
  const shown = c.kinds[kind];
  const monitor = monitors[kind];
  const { line, stretches } = lineOf(monitor.spikes);
  const [stateMark, stateTone] = outcome[monitor.state];
  const choose = useCallback((e: ChangeEvent<HTMLFieldSetElement>) => {
    const next = kinds.find((each) => each === chosenValue(e));
    if (next) {
      setKind(next);
    }
  }, []);
  return (
    <Section backdrop="grid" id="checks" lead={c.lead} title={c.title}>
      <div
        className="mt-16 grid grid-cols-[15rem_minmax(0,1fr)] items-start gap-x-10 max-lg:grid-cols-1 max-lg:gap-y-8"
        ref={ref}
      >
        <fieldset
          aria-label={copy.nav.checks}
          className="flex flex-col gap-1 max-sm:grid-cols-2 max-lg:grid max-lg:grid-cols-3"
          onChange={choose}
        >
          {kinds.map((each) => (
            <label
              className="group grid cursor-pointer grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-x-3 rounded-md px-1 py-3 text-muted transition-colors hover:text-fg has-checked:text-teal-text has-focus-visible:ring-2 has-focus-visible:ring-focus max-lg:grid-cols-[1.75rem_minmax(0,1fr)] max-lg:gap-x-2.5 max-lg:py-2"
              key={each}
            >
              <input
                checked={kind === each}
                className="sr-only"
                name={name}
                readOnly
                type="radio"
                value={each}
              />
              <span className="grid size-9 place-items-center text-muted transition-colors group-hover:text-strong group-has-checked:text-teal-text max-lg:size-7 [&>svg]:size-5 max-lg:[&>svg]:size-4">
                {marks[each]}
              </span>
              <span className="truncate font-medium text-[16px]">
                {c.kinds[each].name}
              </span>
            </label>
          ))}
        </fieldset>
        <Frame className="mt-0!">
          <div className="arrive p-6 text-[14px]" key={kind}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="font-medium text-[17px]">
                {copy.alerts.monitor}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 font-medium text-[13px] ${stateTone}`}
              >
                {stateMark}
                {shown.state}
              </span>
              <span className="token text-[13px] text-strong">
                {shown.target}
              </span>
              <span className="token ms-auto text-[12px] text-muted">
                {shown.name}
              </span>
            </div>
            <dl className="mt-5 grid grid-cols-4 gap-px overflow-hidden bg-line-2 max-sm:grid-cols-2">
              {c.detail.uptime.map((label, n) => (
                <div className="bg-surface px-4 py-3" key={label}>
                  <dt className="text-[13px] text-muted">{label}</dt>
                  <dd className="mt-0.5 font-medium text-[20px] tabular-nums">
                    {monitor.uptimes[n]}
                  </dd>
                </div>
              ))}
            </dl>
            <dl className="mt-5 divide-y divide-line-2 border-line-2 border-y">
              {shown.fields.map(([label, value, shape]) => (
                <div
                  className="grid grid-cols-[9em_1fr] gap-4 py-2.5 max-sm:grid-cols-1 max-sm:gap-1"
                  key={label}
                >
                  <dt className="text-muted">{label}</dt>
                  <dd className="break-all text-fg">
                    {shape === "text" ? (
                      value
                    ) : (
                      <bdi className="token text-[13px]">{value}</bdi>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-5 grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6 max-md:grid-cols-1">
              <div>
                <svg
                  aria-hidden="true"
                  className="mirror block h-[140px] w-full"
                  preserveAspectRatio="none"
                  viewBox="0 0 600 150"
                >
                  <path
                    className="fill-teal-soft"
                    d={`${line} L600,150 L0,150 Z`}
                  />
                  <path
                    className={`stroke-teal ${seen ? "unveil" : "invisible"}`}
                    d={line}
                    fill="none"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                  {stretches.map(([state, d]) => (
                    <path
                      className={stroke[state]}
                      d={d}
                      fill="none"
                      key={d}
                      strokeWidth="2.5"
                      style={{
                        opacity: seen ? 1 : 0,
                        transition: "opacity 400ms 1.2s",
                      }}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
              </div>
              <div>
                <table className="w-full text-[13px]">
                  <tbody>
                    {monitor.recent.map(([at, state, ms], n) => (
                      <tr
                        className="border-line-2 border-t"
                        // biome-ignore lint/suspicious/noArrayIndexKey: a row's place is its identity; a heartbeat repeats its time.
                        key={n}
                      >
                        <td className="token py-1.5 text-strong">{at}</td>
                        <td className={`px-3 py-1.5 ${outcome[state][1]}`}>
                          {outcome[state][0]}
                        </td>
                        <td
                          className={`py-1.5 text-end ${state === "up" ? "" : outcome[state][1]}`}
                        >
                          <Took ms={ms} unit={copy.demo.dayCard.ms} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Frame>
      </div>
    </Section>
  );
}

/** A check's time: the figure in the token face, the unit in the page's language. */
function Took({
  ms,
  unit,
}: {
  readonly ms: number | null;
  readonly unit: string;
}): ReactNode {
  return ms === null ? (
    "—"
  ) : (
    <>
      <span className="token">{ms}</span>{" "}
      <span className="text-[12px] text-muted">{unit}</span>
    </>
  );
}
