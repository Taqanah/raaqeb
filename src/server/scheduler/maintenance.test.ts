import { describe, expect, spyOn, test } from "bun:test";
import { ComponentShapeError } from "@/server/storage/components.ts";
import { MaintenanceShapeError } from "@/server/storage/maintenance.ts";
import type { Component } from "@/shared/schemas/component.ts";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";
import { createMaintenancePass } from "./maintenance.ts";

const hour = 3_600_000;
const t0 = Date.UTC(2026, 8, 26, 10);

function window(
  id: string,
  componentIds: readonly string[],
  startsAt: number,
  endsAt: number,
  stage: MaintenanceWindow["stage"] = "scheduled"
): MaintenanceWindow {
  return {
    componentIds,
    createdAt: t0 - hour,
    endsAt,
    id,
    message: { ar: "نص" },
    stage,
    startsAt,
    title: { ar: id },
    updatedAt: t0 - hour,
  };
}

function component(id: string, monitorIds: readonly string[]): Component {
  return {
    createdAt: t0 - hour,
    description: undefined,
    id,
    monitorIds,
    name: { ar: id },
    status: "operational",
    updatedAt: t0 - hour,
  };
}

/** The stage the repository moves a window to at `now`. */
function stageAt(
  each: MaintenanceWindow,
  now: number
): MaintenanceWindow["stage"] {
  if (each.stage !== "completed" && each.endsAt <= now) {
    return "completed";
  }
  if (each.stage === "scheduled" && each.startsAt <= now) {
    return "in_progress";
  }
  return each.stage;
}

/** An in-memory repository whose `advance` moves stages as the real one does, and a record of what the pass did, in order. */
function world(
  windows: MaintenanceWindow[],
  components: Component[] = [
    component("web", ["site", "shared"]),
    component("api", ["shared", "gateway"]),
  ]
) {
  const calls: string[] = [];
  const faults: {
    advance: boolean;
    links: boolean;
    read: false | "shape" | "down";
  } = {
    advance: false,
    links: false,
    read: false,
  };
  let stopped = false;
  const storage = {
    components: {
      list: () => {
        calls.push("components");
        return faults.links
          ? Promise.reject(new ComponentShapeError("c-bad"))
          : Promise.resolve(components);
      },
    },
    maintenance: {
      advance: (now: number) => {
        calls.push("advance");
        if (faults.advance) {
          return Promise.reject(new Error("the database did not answer"));
        }
        const moved: MaintenanceWindow[] = [];
        for (const [index, each] of windows.entries()) {
          const stage = stageAt(each, now);
          if (stage !== each.stage) {
            windows[index] = { ...each, stage };
            moved.push({ ...each, stage });
          }
        }
        return Promise.resolve(moved);
      },
      unfinished: () => {
        calls.push("unfinished");
        if (faults.read === "shape") {
          return Promise.reject(new MaintenanceShapeError("w-bad"));
        }
        if (faults.read === "down") {
          return Promise.reject(new Error("the database did not answer"));
        }
        return Promise.resolve(
          windows.filter((each) => each.stage !== "completed")
        );
      },
    },
  };
  const moved: MaintenanceWindow[] = [];
  /** Whether the first monitor was covered when each bump ran. */
  const coveredAtBump: boolean[] = [];
  const pass = createMaintenancePass(storage, {
    bump: () => {
      calls.push("bump");
      coveredAtBump.push(pass.covers("site"));
      return Promise.resolve();
    },
    isStopped: () => stopped,
    onMoved: (each) => {
      moved.push(each);
    },
    onUncovered: (monitorIds) => {
      calls.push(`uncovered ${monitorIds.join(",")}`);
      return Promise.resolve();
    },
  });
  return {
    calls,
    count: (call: string) => calls.filter((each) => each === call).length,
    coveredAtBump,
    faults,
    moved,
    pass,
    stop: () => {
      stopped = true;
    },
    windows,
  };
}

const quiet = () =>
  spyOn(process.stderr, "write").mockImplementation(() => true);

describe("the scheduler's maintenance pass", () => {
  test("before the next edge, a tick costs no query", async () => {
    const w = world([window("w1", ["web"], t0 + hour, t0 + 2 * hour)]);
    expect(await w.pass.read()).toBe(true);
    for (const at of [t0, t0 + 1000, t0 + hour - 1]) {
      // biome-ignore lint/performance/noAwaitInLoops: ticks one after another
      await w.pass.run(at);
    }
    expect(w.count("advance")).toBe(0);
  });

  test("at a window's start it moves the window, moves the counter once, hands it on, and covers the monitors linked to its components", async () => {
    const w = world([window("w1", ["web"], t0 + hour, t0 + 2 * hour)]);
    await w.pass.read();
    expect(w.pass.covers("site")).toBe(false);
    await w.pass.run(t0 + hour);
    expect(w.count("advance")).toBe(1);
    expect(w.count("bump")).toBe(1);
    expect(w.moved.map((each) => [each.id, each.stage])).toEqual([
      ["w1", "in_progress"],
    ]);
    expect(w.pass.covers("site")).toBe(true);
    expect(w.pass.covers("shared")).toBe(true);
    expect(w.pass.covers("gateway")).toBe(false);
  });

  test("two windows due at one tick move the counter once", async () => {
    const w = world([
      window("w1", ["web"], t0 + hour, t0 + 2 * hour),
      window("w2", ["api"], t0 + hour, t0 + 3 * hour),
    ]);
    await w.pass.read();
    await w.pass.run(t0 + hour);
    expect(w.count("bump")).toBe(1);
    expect(w.moved).toHaveLength(2);
  });

  test("at a window's end its monitors are handed on as uncovered, after the counter moved", async () => {
    const w = world([window("w1", ["web"], t0 + hour, t0 + 2 * hour)]);
    await w.pass.read();
    await w.pass.run(t0 + hour);
    await w.pass.run(t0 + 2 * hour);
    expect(w.pass.covers("site")).toBe(false);
    const end = w.calls.slice(w.calls.lastIndexOf("advance"));
    expect(end).toEqual(["advance", "bump", "uncovered site,shared"]);
    expect(w.moved.at(-1)?.stage).toBe("completed");
  });

  test("a monitor another window in progress still covers is not handed on", async () => {
    const w = world([
      window("w1", ["web"], t0 + hour, t0 + 2 * hour),
      window("w2", ["api"], t0 + hour, t0 + 3 * hour),
    ]);
    await w.pass.read();
    await w.pass.run(t0 + hour);
    await w.pass.run(t0 + 2 * hour);
    expect(w.calls.at(-1)).toBe("uncovered site");
    expect(w.pass.covers("shared")).toBe(true);
  });

  test("a window whose start and end both passed while stopped completes at the first tick and hands on no monitor, since none was covered", async () => {
    const w = world([window("w1", ["web"], t0 - 3 * hour, t0 - 2 * hour)]);
    await w.pass.read();
    await w.pass.run(t0);
    expect(w.moved.map((each) => each.stage)).toEqual(["completed"]);
    expect(w.calls.filter((each) => each.startsWith("uncovered"))).toEqual([]);
  });

  test("a read after the operator's change moves the next edge: a window ended now completes at the next tick", async () => {
    const w = world([window("w1", ["web"], t0, t0 + 5 * hour)]);
    await w.pass.read();
    await w.pass.run(t0);
    expect(w.pass.covers("site")).toBe(true);
    const [running] = w.windows;
    if (running) {
      w.windows[0] = { ...running, endsAt: t0 + hour };
    }
    await w.pass.run(t0 + hour);
    expect(w.pass.covers("site")).toBe(true);
    await w.pass.read();
    await w.pass.run(t0 + hour);
    expect(w.pass.covers("site")).toBe(false);
    expect(w.calls.at(-1)).toBe("uncovered site,shared");
  });

  test("a read that fails answers false and keeps what it knew; a window this version cannot read is logged and settled", async () => {
    const w = world([window("w1", ["web"], t0, t0 + hour)]);
    await w.pass.read();
    await w.pass.run(t0);
    const stderr = quiet();
    try {
      w.faults.read = "down";
      expect(await w.pass.read()).toBe(false);
      expect(w.pass.covers("site")).toBe(true);
      w.faults.read = "shape";
      expect(await w.pass.read()).toBe(true);
      expect(w.pass.covers("site")).toBe(true);
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("w-bad");
    } finally {
      stderr.mockRestore();
    }
  });

  test("a move that fails is logged and tried again at the next tick", async () => {
    const w = world([window("w1", ["web"], t0, t0 + hour)]);
    await w.pass.read();
    const stderr = quiet();
    try {
      w.faults.advance = true;
      await w.pass.run(t0);
      expect(w.pass.covers("site")).toBe(false);
      expect(stderr.mock.calls.length).toBeGreaterThan(0);
    } finally {
      stderr.mockRestore();
    }
    w.faults.advance = false;
    await w.pass.run(t0 + 1000);
    expect(w.count("advance")).toBe(2);
    expect(w.pass.covers("site")).toBe(true);
  });

  test("once the scheduler stops, the pass moves nothing", async () => {
    const w = world([window("w1", ["web"], t0, t0 + hour)]);
    await w.pass.read();
    w.stop();
    await w.pass.run(t0);
    expect(w.count("advance")).toBe(0);
  });

  test("before its first read the pass covers nothing and moves nothing", async () => {
    const w = world([
      window("w1", ["web"], t0 - hour, t0 + hour, "in_progress"),
    ]);
    await w.pass.run(t0);
    expect(w.pass.covers("site")).toBe(false);
    expect(w.count("advance")).toBe(0);
  });
});

describe("edges of the maintenance pass", () => {
  test("an edge the database no longer holds is read again once, not moved at every tick", async () => {
    const w = world([window("w1", ["web"], t0 + hour, t0 + 2 * hour)]);
    await w.pass.read();
    // Cancelled since the pass read it, with the read of the counter's move still to come.
    w.windows.splice(0, 1);
    await w.pass.run(t0 + hour);
    await w.pass.run(t0 + hour + 1000);
    await w.pass.run(t0 + hour + 2000);
    expect(w.count("advance")).toBe(1);
    expect(w.count("bump")).toBe(0);
  });
});

describe("the maintenance pass: edge cases", () => {
  test("a component this version cannot read settles the read, so the scheduler does not read everything again at every tick", async () => {
    const w = world([window("w1", ["web"], t0, t0 + hour)]);
    const stderr = quiet();
    try {
      w.faults.links = true;
      expect(await w.pass.read()).toBe(true);
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("c-bad");
    } finally {
      stderr.mockRestore();
    }
  });

  test("a window's monitors stay covered until the moment they are handed on, so a check settling meanwhile is held for the notification at the end", async () => {
    const w = world([window("w1", ["web"], t0, t0 + hour)]);
    await w.pass.read();
    await w.pass.run(t0);
    await w.pass.run(t0 + hour);
    expect(w.coveredAtBump.at(-1)).toBe(true);
    expect(w.calls.at(-1)).toBe("uncovered site,shared");
  });

  test("a move under way when the scheduler stops is waited for", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createMaintenancePass(
      {
        components: {
          list: () => Promise.resolve([component("web", ["site"])]),
        },
        maintenance: {
          advance: async () => {
            await gate;
            return [window("w1", ["web"], t0, t0 + hour, "in_progress")];
          },
          unfinished: () =>
            Promise.resolve([window("w1", ["web"], t0, t0 + hour)]),
        },
      },
      {
        bump: () => Promise.resolve(),
        isStopped: () => false,
        onUncovered: () => Promise.resolve(),
      }
    );
    await slow.read();
    const running = slow.run(t0);
    let idle = false;
    const waited = slow.idle().then(() => {
      idle = true;
    });
    await Bun.sleep(5);
    expect(idle).toBe(false);
    release();
    await running;
    await waited;
    expect(idle).toBe(true);
  });
});
