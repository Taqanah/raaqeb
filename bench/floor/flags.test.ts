import { describe, expect, test } from "bun:test";
import {
  type Flags,
  fullPhaseSeconds,
  parseFlags,
  sweepLengths,
  wiringPhaseSeconds,
} from "./flags.ts";
import { defaultRunFlags } from "./results.ts";

function parsed(args: readonly string[]): Flags {
  const result = parseFlags(args);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.flags;
}

function refusal(args: readonly string[]): string {
  const result = parseFlags(args);
  if (result.ok) {
    throw new Error("expected a refusal");
  }
  return result.message;
}

describe("the harness's command line", () => {
  test("no flags ask for one full release profile of 200 monitors at 20 s on the shipped image, every variant", () => {
    expect(parsed([])).toEqual({
      dayMonitors: defaultRunFlags.dayMonitors,
      daySeconds: fullPhaseSeconds.day,
      idleSeconds: fullPhaseSeconds.idle,
      image: undefined,
      intervalSeconds: 20,
      loadSeconds: fullPhaseSeconds.load,
      monitors: 200,
      passThrough: [],
      rate: 20,
      runs: 1,
      short: false,
      standIn: false,
      variants: ["sqlite", "postgres", "musl"],
      wiring: false,
    });
  });

  test("no flags ask for exactly a release's run, the one the history and the band take", () => {
    const flags = parsed([]);
    expect({
      dayMonitors: flags.dayMonitors,
      daySeconds: flags.daySeconds,
      idleSeconds: flags.idleSeconds,
      intervalSeconds: flags.intervalSeconds,
      loadSeconds: flags.loadSeconds,
      monitors: flags.monitors,
      rate: flags.rate,
      short: flags.short,
    }).toEqual(defaultRunFlags);
  });

  test("a flag reads the same with a space or an equals sign", () => {
    expect(parsed(["--monitors", "7", "--rate=40"])).toMatchObject({
      monitors: 7,
      rate: 40,
    });
    expect(parsed(["--monitors=7", "--rate", "40"])).toMatchObject({
      monitors: 7,
      rate: 40,
    });
  });

  test("a bare separator is ignored, so bun run stripping it changes nothing", () => {
    expect(parsed(["--", "--monitors", "3", "--"])).toEqual(
      parsed(["--monitors", "3"])
    );
  });

  test("--wiring shortens every phase and marks the run a wiring check", () => {
    expect(parsed(["--wiring"])).toMatchObject({
      daySeconds: wiringPhaseSeconds.day,
      idleSeconds: wiringPhaseSeconds.idle,
      loadSeconds: wiringPhaseSeconds.load,
      wiring: true,
    });
  });

  test("the release's accelerated day runs ten minutes, and a shorter one makes a wiring run", () => {
    expect(fullPhaseSeconds.day).toBe(600);
    expect(parsed(["--day", "599"])).toMatchObject({
      daySeconds: 599,
      wiring: true,
    });
    expect(parsed(["--day", "600"]).wiring).toBe(false);
  });

  test("the release's day holds more monitors than the fixed run, so it runs more checks in its ten minutes", () => {
    expect(defaultRunFlags.dayMonitors).toBeGreaterThan(
      defaultRunFlags.monitors
    );
  });

  test("--day-monitors sets the day's count alone", () => {
    const flags = parsed(["--day-monitors", "900"]);
    expect(flags.dayMonitors).toBe(900);
    expect(flags.monitors).toBe(200);
    expect(refusal(["--day-monitors", "0"])).toContain("--day-monitors");
  });

  test("a short run leaves the day out, so its length does not make it a wiring run", () => {
    expect(parsed(["--short", "--day", "60"]).wiring).toBe(false);
    expect(parsed(["--short"]).short).toBe(true);
  });

  test("--variant picks the variants to run, in the order given, each once", () => {
    expect(
      parsed(["--variant", "musl", "--variant=sqlite", "--variant", "musl"])
        .variants
    ).toEqual(["musl", "sqlite"]);
  });

  test("a variant the harness does not know is refused", () => {
    expect(refusal(["--variant", "mysql"])).toContain("--variant");
  });

  test("--stand-in measures this checkout's build instead of a shipped image", () => {
    expect(parsed(["--stand-in"])).toMatchObject({
      image: undefined,
      standIn: true,
    });
  });

  test("the stand-in leaves the musl variant out, since only a shipped build has its binary", () => {
    expect(parsed(["--stand-in"]).variants).toEqual(["sqlite", "postgres"]);
    expect(refusal(["--stand-in", "--variant", "musl"])).toContain("musl");
  });

  test("--stand-in and --image together are refused, since the run measures one of them", () => {
    expect(refusal(["--stand-in", "--image", "raaqeb:0.1.0"])).toContain(
      "--stand-in"
    );
  });

  test.each(["--short", "--stand-in", "--wiring"])(
    "%s takes no value",
    (flag) => {
      expect(refusal([`${flag}=yes`])).toContain(flag);
    }
  );

  test("a phase length given with --wiring wins over the wiring default", () => {
    expect(parsed(["--wiring", "--idle", "60"])).toMatchObject({
      idleSeconds: 60,
      loadSeconds: wiringPhaseSeconds.load,
      wiring: true,
    });
  });

  test("any phase shorter than its full length makes a wiring run", () => {
    expect(parsed(["--idle", "60"]).wiring).toBe(true);
    expect(parsed(["--load", String(fullPhaseSeconds.load - 1)]).wiring).toBe(
      true
    );
  });

  test("phases at or past their full length make a run whose numbers count", () => {
    expect(
      parsed([
        "--idle",
        String(fullPhaseSeconds.idle),
        "--load",
        String(fullPhaseSeconds.load * 2),
      ]).wiring
    ).toBe(false);
  });

  test("--image names a shipped image to measure instead of this version's", () => {
    expect(parsed(["--image", "ghcr.io/example/raaqeb:1.0.0"]).image).toBe(
      "ghcr.io/example/raaqeb:1.0.0"
    );
  });

  test("--runs and --interval are read as counts", () => {
    expect(parsed(["--runs", "10", "--interval", "1"])).toMatchObject({
      intervalSeconds: 1,
      runs: 10,
    });
  });

  test("words the harness does not know pass through to raaqeb serve in order", () => {
    expect(
      parsed([
        "--trusted-proxies",
        "10.0.0.1",
        "--monitors",
        "3",
        "--secret-key=abc",
      ])
    ).toMatchObject({
      monitors: 3,
      passThrough: ["--trusted-proxies", "10.0.0.1", "--secret-key=abc"],
    });
  });

  test.each([
    ["--monitors", "0"],
    ["--monitors", "-3"],
    ["--rate", "fast"],
    ["--runs", "1.5"],
    ["--interval", ""],
    ["--idle", "1e3"],
    ["--load", " 30"],
  ])("%s %p is refused, and the message names the flag", (flag, value) => {
    expect(refusal([flag, value])).toContain(flag);
  });

  test("a counted flag with no value is refused", () => {
    expect(refusal(["--monitors"])).toContain("--monitors");
    expect(refusal(["--image"])).toContain("--image");
  });

  test("--image with an empty name is refused", () => {
    expect(refusal(["--image="])).toContain("--image");
  });

  test("another flag is never read as a value", () => {
    expect(refusal(["--image", "--wiring"])).toContain("--image");
    expect(refusal(["--monitors", "--rate", "3"])).toContain("--monitors");
  });
});

describe("the sweeps' lengths", () => {
  test("a full run warms each capacity step past the first runs' spread and one interval, then measures two intervals", () => {
    const full = sweepLengths(false);
    expect(full.capacityWarm).toBeGreaterThanOrEqual(30 + 20);
    expect(full.capacityMeasure).toBe(40);
    expect(full.throughput).toBe(15);
    expect(full.capacityMonitors).toBeGreaterThanOrEqual(25_600);
  });

  test("with no previous release the capacity sweep starts at 1,600, and a wiring run at the fixed count", () => {
    expect(sweepLengths(false).capacityFirst).toBe(1600);
    expect(sweepLengths(true).capacityFirst).toBe(200);
  });

  test("a wiring run keeps every sweep short and small", () => {
    const wiring = sweepLengths(true);
    const full = sweepLengths(false);
    expect(wiring.capacityWarm).toBeLessThan(full.capacityWarm);
    expect(wiring.capacityMeasure).toBeLessThan(full.capacityMeasure);
    expect(wiring.throughput).toBeLessThan(full.throughput);
    expect(wiring.capacityMonitors).toBeLessThanOrEqual(800);
  });
});
