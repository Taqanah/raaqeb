import { describe, expect, test } from "bun:test";
import type { CheckOutcome, CheckResult } from "@/shared/schemas/check.ts";
import { mainLocation } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import {
  freshForMs,
  type LocatedMonitor,
  type LocationResult,
  locationResultFromProbe,
  locationResultOf,
  noRecentResult,
  verdictOf,
  verdictOutcome,
} from "./locations.ts";

const now = 1_700_000_000_000;
const frankfurt = "0199f0aa-0000-7000-8000-000000000001";
const riyadh = "0199f0aa-0000-7000-8000-000000000002";

const monitor: LocatedMonitor = {
  confirmations: 2,
  id: "m",
  intervalMs: 60_000,
  locations: [mainLocation, frankfurt, riyadh],
  retries: 0,
  timeoutMs: 10_000,
  updatedAt: 0,
};

function seen(
  result: CheckResult,
  agoMs = 5000,
  responseMs: number | undefined = 100
): LocationResult {
  return {
    attempts: 1,
    bytes: 10,
    reason: result === "down" ? reasons.timeout : reasons.ok,
    responseMs,
    result,
    startedAt: now - agoMs,
    statusCode: result === "down" ? undefined : 200,
  };
}

const held = (entries: Record<string, LocationResult>) =>
  new Map(Object.entries(entries));

describe("a location's state", () => {
  test("is known for twice the interval plus the longest the check can take", () => {
    expect(
      freshForMs({ intervalMs: 60_000, retries: 2, timeoutMs: 10_000 })
    ).toBe(2 * 60_000 + 3 * 10_000 + 2 * 1000);
  });

  test("a result whose check started before the monitor last changed, an edit, a pause or a resume, counts for nothing", () => {
    const changed = { ...monitor, confirmations: 1, updatedAt: now - 1000 };
    expect(
      verdictOf(
        changed,
        held({ [frankfurt]: seen("down", 5000), main: seen("up", 500) }),
        now
      )
    ).toMatchObject({ down: [], from: mainLocation, result: "up" });
    expect(
      verdictOf(changed, held({ [frankfurt]: seen("down", 5000) }), now)
    ).toBeUndefined();
  });

  test("a result whose check started exactly as the monitor last changed counts", () => {
    expect(
      verdictOf(
        {
          ...monitor,
          confirmations: 1,
          locations: [frankfurt],
          updatedAt: now - 1000,
        },
        held({ [frankfurt]: seen("down", 1000) }),
        now
      )?.result
    ).toBe("down");
  });

  test("a result exactly as old as the bound still counts", () => {
    expect(
      verdictOf(
        { ...monitor, locations: [frankfurt] },
        held({ [frankfurt]: seen("down", freshForMs(monitor)) }),
        now
      )?.result
    ).toBe("down");
  });

  test("an older result is unknown and counts for nothing", () => {
    const stale = freshForMs(monitor) + 1;
    expect(
      verdictOf(
        { ...monitor, locations: [frankfurt] },
        held({ [frankfurt]: seen("down", stale) }),
        now
      )
    ).toBeUndefined();
  });
});

describe("the verdict of a monitor's locations", () => {
  test("a monitor checked from the main location alone is what its own check saw", () => {
    const own = { ...monitor, confirmations: undefined, locations: undefined };
    expect(verdictOf(own, held({ main: seen("down") }), now)).toEqual({
      down: [mainLocation],
      from: mainLocation,
      known: 1,
      result: "down",
    });
  });

  test("one location down is not an outage when two must agree", () => {
    const verdict = verdictOf(
      monitor,
      held({
        [frankfurt]: seen("up"),
        [riyadh]: seen("up"),
        main: seen("down"),
      }),
      now
    );
    expect(verdict).toEqual({
      down: [mainLocation],
      from: frankfurt,
      known: 3,
      result: "up",
    });
  });

  test("two locations down are an outage when two must agree, and the check carries the main location's figures", () => {
    expect(
      verdictOf(
        monitor,
        held({
          [frankfurt]: seen("down"),
          [riyadh]: seen("up"),
          main: seen("down"),
        }),
        now
      )
    ).toEqual({
      down: [mainLocation, frankfurt],
      from: mainLocation,
      known: 3,
      result: "down",
    });
  });

  test("the probes' agreement is enough without the main location, the first of them in the monitor's order lending its figures", () => {
    expect(
      verdictOf(
        monitor,
        held({
          [frankfurt]: seen("down"),
          [riyadh]: seen("down"),
          main: seen("up"),
        }),
        now
      )
    ).toEqual({
      down: [frankfurt, riyadh],
      from: frankfurt,
      known: 3,
      result: "down",
    });
  });

  test("a silent probe never hides an outage: while fewer locations are known than must agree, every known one decides", () => {
    const silent = freshForMs(monitor) + 1;
    expect(
      verdictOf(
        monitor,
        held({
          [frankfurt]: seen("up", silent),
          main: seen("down"),
        }),
        now
      )?.result
    ).toBe("down");
  });

  test("a location the monitor is no longer checked from counts for nothing", () => {
    expect(
      verdictOf(
        { ...monitor, confirmations: 1, locations: [mainLocation] },
        held({ [frankfurt]: seen("down"), main: seen("up") }),
        now
      )?.result
    ).toBe("up");
  });

  test("degraded needs as many locations degraded or down", () => {
    expect(
      verdictOf(
        monitor,
        held({
          [frankfurt]: seen("degraded"),
          [riyadh]: seen("up"),
          main: seen("down"),
        }),
        now
      )
    ).toEqual({
      down: [mainLocation],
      from: frankfurt,
      known: 3,
      result: "degraded",
    });
    expect(
      verdictOf(
        monitor,
        held({
          [frankfurt]: seen("degraded"),
          [riyadh]: seen("up"),
          main: seen("up"),
        }),
        now
      )?.result
    ).toBe("up");
  });

  test("with no location known there is no verdict", () => {
    expect(verdictOf(monitor, new Map(), now)).toBeUndefined();
  });
});

describe("a monitor checked from probes alone", () => {
  const probesOnly = {
    intervalMs: 60_000,
    locations: [frankfurt],
    paused: false,
    retries: 0,
    timeoutMs: 10_000,
  };
  const bound = freshForMs(probesOnly);

  test("has no recent result once its latest check is older than the bound, and not before", () => {
    expect(noRecentResult(probesOnly, now - bound, now)).toBe(false);
    expect(noRecentResult(probesOnly, now - bound - 1, now)).toBe(true);
  });

  test("has none to report before its first check, while paused, or while the main location also checks it", () => {
    expect(noRecentResult(probesOnly, undefined, now)).toBe(false);
    expect(
      noRecentResult({ ...probesOnly, paused: true }, now - bound - 1, now)
    ).toBe(false);
    expect(
      noRecentResult(
        { ...probesOnly, locations: [mainLocation, frankfurt] },
        now - bound - 1,
        now
      )
    ).toBe(false);
    expect(
      noRecentResult(
        { ...probesOnly, locations: undefined },
        now - bound - 1,
        now
      )
    ).toBe(false);
  });
});

describe("the check the install writes for a verdict", () => {
  const own: CheckOutcome = {
    capture: {
      body: new Uint8Array([1]),
      headers: [],
      monitorId: "m",
      startedAt: now - 5000,
    },
    check: {
      attempts: 2,
      bytes: 0,
      monitorId: "m",
      reason: reasons.timeout,
      responseMs: undefined,
      result: "down",
      startedAt: now - 5000,
      statusCode: undefined,
    },
    detail: {
      assertion: undefined,
      error: "timed out",
      monitorId: "m",
      params: { reason: "timeout", timeoutMs: 10_000 },
      startedAt: now - 5000,
    },
  };

  test("carries the main location's own check whole when it lends its figures", () => {
    const states = held({
      [frankfurt]: seen("down"),
      main: locationResultOf(own),
    });
    const outcome = verdictOutcome(
      "m",
      {
        down: [mainLocation, frankfurt],
        from: mainLocation,
        known: 2,
        result: "down",
      },
      states,
      now - 5000,
      own
    );
    expect(outcome).toEqual(own);
  });

  test("carries a probe's figures at the install's time, with its failure detail and no capture", () => {
    const probe: LocationResult = {
      ...seen("down", 20_000),
      detail: {
        assertion: undefined,
        error: "connect ECONNREFUSED",
        params: {
          host: "example.test",
          port: 443,
          reason: "connection_refused",
        },
      },
      reason: reasons.connection_refused,
    };
    const outcome = verdictOutcome(
      "m",
      { down: [frankfurt], from: frankfurt, known: 1, result: "down" },
      held({ [frankfurt]: probe }),
      now,
      undefined
    );
    expect(outcome).toEqual({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 10,
        monitorId: "m",
        reason: reasons.connection_refused,
        responseMs: 100,
        result: "down",
        startedAt: now,
        statusCode: undefined,
      },
      detail: {
        assertion: undefined,
        error: "connect ECONNREFUSED",
        monitorId: "m",
        params: {
          host: "example.test",
          port: 443,
          reason: "connection_refused",
        },
        startedAt: now,
      },
    });
  });

  test("an up verdict lent by a probe keeps no failure detail and no capture of the main location's failed check", () => {
    const outcome = verdictOutcome(
      "m",
      { down: [mainLocation], from: frankfurt, known: 2, result: "up" },
      held({ [frankfurt]: seen("up", 1000, 87), main: locationResultOf(own) }),
      now - 5000,
      own
    );
    expect(outcome.check).toMatchObject({
      reason: reasons.ok,
      responseMs: 87,
      result: "up",
      startedAt: now - 5000,
      statusCode: 200,
    });
    expect(outcome.detail).toBeUndefined();
    expect(outcome.capture).toBeUndefined();
  });
});

describe("a probe's result", () => {
  test("is placed at the install's receipt time minus its age, whatever the probe's clock says", () => {
    const placed = locationResultFromProbe(
      {
        ageMs: 4200,
        attempts: 1,
        bytes: 3,
        monitorId: "m",
        reason: "unexpected_status",
        responseMs: 55,
        result: "down",
        statusCode: 503,
      },
      now
    );
    expect(placed).toEqual({
      attempts: 1,
      bytes: 3,
      detail: undefined,
      reason: reasons.unexpected_status,
      responseMs: 55,
      result: "down",
      startedAt: now - 4200,
      statusCode: 503,
    });
  });
});
