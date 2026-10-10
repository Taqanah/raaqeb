/**
 * The harness's command line: its own flags, parsed here rather
 * than after `--`, because `bun run script -- a b` strips two separators on
 * Bun 1.4.2. A bare `--` is ignored; every other word the harness does not
 * know passes through, in order, to the `raaqeb serve` command in the
 * container. A run shorter than the full phases is a wiring run.
 */

import { defaultRunFlags, type Variant, variants } from "./results.ts";

/** What one invocation asks for. */
export interface Flags {
  /** How many monitors the accelerated day seeds at 1 s. */
  readonly dayMonitors: number;
  /** Seconds of the accelerated day. */
  readonly daySeconds: number;
  /** Seconds of the idle phase: the seeded monitors run, nothing else calls the install. */
  readonly idleSeconds: number;
  /** The image to measure; none means the shipped image of this checkout's version. */
  readonly image: string | undefined;
  /** Seconds between two checks of every seeded monitor in the fixed run. */
  readonly intervalSeconds: number;
  /** Seconds of the load phase. */
  readonly loadSeconds: number;
  /** How many monitors the fixed run seeds. */
  readonly monitors: number;
  /** Words for the `raaqeb serve` command in the container. */
  readonly passThrough: readonly string[];
  /** The load phase's fixed arrival rate, in requests a second. */
  readonly rate: number;
  /** How many runs of the same build; two or more also write a noise band. */
  readonly runs: number;
  /** The fixed run alone for every variant, SQLite's day and sweeps left out. */
  readonly short: boolean;
  /** A stand-in over this checkout's build in place of a shipped image. */
  readonly standIn: boolean;
  /** The variants to run, in the order given; all three by default. */
  readonly variants: readonly Variant[];
  /** True when a phase is shorter than the full length: a wiring check, never a number to quote. */
  readonly wiring: boolean;
}

export type FlagsResult =
  | { readonly flags: Flags; readonly ok: true }
  | { readonly message: string; readonly ok: false };

/** The phase lengths of a full run, in seconds. */
export const fullPhaseSeconds = {
  day: defaultRunFlags.daySeconds,
  idle: defaultRunFlags.idleSeconds,
  load: defaultRunFlags.loadSeconds,
} as const;

/** The phase lengths `--wiring` asks for, in seconds. */
export const wiringPhaseSeconds = { day: 60, idle: 15, load: 15 } as const;

/** The usage line printed on a refused command line. */
export const usage =
  "usage: bun bench/floor/run.ts [--variant sqlite|postgres|musl]... [--short] [--monitors n] [--day-monitors n] [--interval s] [--idle s] [--load s] [--day s] [--rate n] [--runs n] [--image ref | --stand-in] [--wiring] [raaqeb serve flags]";

/** How long the sweeps hold each step, in seconds, and how far the capacity sweep doubles. */
export interface SweepLengths {
  /** The capacity sweep's first count when no previous release says where to start. */
  readonly capacityFirst: number;
  /** Seconds the capacity sweep measures lateness over, after its warm-up. */
  readonly capacityMeasure: number;
  /** The capacity sweep's largest count. */
  readonly capacityMonitors: number;
  /** Seconds a capacity step runs before it measures: the first runs' spread and one interval. */
  readonly capacityWarm: number;
  /** Seconds each throughput path is held. */
  readonly throughput: number;
}

/** The sweeps' lengths for a full run or a wiring check. */
export function sweepLengths(wiring: boolean): SweepLengths {
  return wiring
    ? {
        capacityFirst: 200,
        capacityMeasure: 20,
        capacityMonitors: 800,
        capacityWarm: 35,
        throughput: 5,
      }
    : {
        capacityFirst: 1600,
        capacityMeasure: 40,
        capacityMonitors: 51_200,
        capacityWarm: 50,
        throughput: 15,
      };
}

const counted = {
  "--day": "daySeconds",
  "--day-monitors": "dayMonitors",
  "--idle": "idleSeconds",
  "--interval": "intervalSeconds",
  "--load": "loadSeconds",
  "--monitors": "monitors",
  "--rate": "rate",
  "--runs": "runs",
} as const;
type CountedFlag = keyof typeof counted;
type Counted = (typeof counted)[CountedFlag];

/** The flags that take no value. */
const switches = ["--short", "--stand-in", "--wiring"] as const;
type Switch = (typeof switches)[number];

const wholeNumber = /^[1-9]\d*$/;

function isCounted(flag: string): flag is CountedFlag {
  return Object.hasOwn(counted, flag);
}

function isSwitch(flag: string): flag is Switch {
  return (switches as readonly string[]).includes(flag);
}

function isVariant(value: string): value is Variant {
  return (variants as readonly string[]).includes(value);
}

function refuse(message: string): FlagsResult {
  return { message: `${message}\n${usage}`, ok: false };
}

/** Why a flag's value is refused, or nothing when it is good. */
function refusalOf(
  flag: string,
  value: string | undefined
): string | undefined {
  if (isSwitch(flag)) {
    return value === "" ? undefined : `${flag} takes no value`;
  }
  if (value === undefined) {
    return `${flag} needs a value`;
  }
  if (flag === "--image") {
    return value === "" ? "--image needs an image name" : undefined;
  }
  if (flag === "--variant") {
    return isVariant(value)
      ? undefined
      : `--variant takes ${variants.join(", ")}`;
  }
  return wholeNumber.test(value)
    ? undefined
    : `${flag} takes a whole number above zero`;
}

/** One word read: the flag and its value, or a word for `raaqeb serve`, and how many words it took. */
function read(
  word: string,
  next: string | undefined
): { own?: [flag: string, value: string | undefined]; taken: number } {
  const equals = word.indexOf("=");
  const flag = equals === -1 ? word : word.slice(0, equals);
  const inline = equals === -1 ? undefined : word.slice(equals + 1);
  if (isSwitch(flag)) {
    return { own: [flag, inline ?? ""], taken: 1 };
  }
  if (!(isCounted(flag) || flag === "--image" || flag === "--variant")) {
    return { taken: 1 };
  }
  if (inline !== undefined) {
    return { own: [flag, inline], taken: 1 };
  }
  // Another flag is never a value: `--image --wiring` names no image.
  return next === undefined || next.startsWith("--")
    ? { own: [flag, undefined], taken: 1 }
    : { own: [flag, next], taken: 2 };
}

/** Every variant, but the musl binary under the stand-in, which only a shipped build has. */
function defaultVariants(asked: Asked): Variant[] {
  return asked.switched.has("--stand-in")
    ? variants.filter((variant) => variant !== "musl")
    : [...variants];
}

/** What the words asked for, before the defaults. */
interface Asked {
  counts: Partial<Record<Counted, number>>;
  image: string | undefined;
  passThrough: string[];
  switched: Set<Switch>;
  variants: Variant[];
}

/** The flags from what was asked, each missing one at its default. */
function completed(asked: Asked): Flags {
  const { counts } = asked;
  const short = asked.switched.has("--short");
  const phases = asked.switched.has("--wiring")
    ? wiringPhaseSeconds
    : fullPhaseSeconds;
  const idleSeconds = counts.idleSeconds ?? phases.idle;
  const loadSeconds = counts.loadSeconds ?? phases.load;
  const daySeconds = counts.daySeconds ?? phases.day;
  return {
    dayMonitors: counts.dayMonitors ?? defaultRunFlags.dayMonitors,
    daySeconds,
    idleSeconds,
    image: asked.image,
    intervalSeconds: counts.intervalSeconds ?? defaultRunFlags.intervalSeconds,
    loadSeconds,
    monitors: counts.monitors ?? defaultRunFlags.monitors,
    passThrough: asked.passThrough,
    rate: counts.rate ?? defaultRunFlags.rate,
    runs: counts.runs ?? 1,
    short,
    standIn: asked.switched.has("--stand-in"),
    variants:
      asked.variants.length > 0 ? asked.variants : defaultVariants(asked),
    wiring:
      idleSeconds < fullPhaseSeconds.idle ||
      loadSeconds < fullPhaseSeconds.load ||
      (!short && daySeconds < fullPhaseSeconds.day),
  };
}

/** Parses the words after the script name. Accepts `--flag value` and `--flag=value`. */
export function parseFlags(args: readonly string[]): FlagsResult {
  const words = args.filter((word) => word !== "--");
  const asked: Asked = {
    counts: {},
    image: undefined,
    passThrough: [],
    switched: new Set(),
    variants: [],
  };
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    const { own, taken } = read(word, words[index + 1]);
    index += taken;
    if (!own) {
      asked.passThrough.push(word);
      continue;
    }
    const [flag, value = ""] = own;
    const refusal = refusalOf(flag, own[1]);
    if (refusal !== undefined) {
      return refuse(refusal);
    }
    if (isSwitch(flag)) {
      asked.switched.add(flag);
    } else if (isCounted(flag)) {
      asked.counts[counted[flag]] = Number(value);
    } else if (flag === "--image") {
      asked.image = value;
    } else if (isVariant(value) && !asked.variants.includes(value)) {
      asked.variants.push(value);
    }
  }
  if (asked.switched.has("--stand-in") && asked.variants.includes("musl")) {
    return refuse(
      "--stand-in has no musl binary to measure; build one with bun run binaries and drop --stand-in, or leave --variant musl out"
    );
  }
  if (asked.switched.has("--stand-in") && asked.image !== undefined) {
    return refuse("--stand-in and --image each name what to measure; give one");
  }
  return { flags: completed(asked), ok: true };
}
