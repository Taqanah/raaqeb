import { describe, expect, test } from "bun:test";
import { probeSilentAfterMs } from "@/shared/schemas/probe.ts";
import { probeStateOf } from "./probes.ts";

const now = 1_000_000_000;

describe("a probe's state", () => {
  test("is never until the install has heard from it", () => {
    expect(probeStateOf({ lastSeenAt: undefined }, now, false)).toBe("never");
  });

  test("is reporting while its last contact is within four of its pulls, and silent from then on", () => {
    expect(
      probeStateOf({ lastSeenAt: now - probeSilentAfterMs + 1 }, now, false)
    ).toBe("reporting");
    expect(
      probeStateOf({ lastSeenAt: now - probeSilentAfterMs }, now, false)
    ).toBe("silent");
  });

  test("is refused when the install refused its latest push whole, whatever its last contact or none", () => {
    expect(probeStateOf({ lastSeenAt: now }, now, true)).toBe("refused");
    expect(probeStateOf({ lastSeenAt: undefined }, now, true)).toBe("refused");
  });
});
