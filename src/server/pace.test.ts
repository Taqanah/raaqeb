import { describe, expect, test } from "bun:test";
import {
  busyAnswer,
  createBodyBudget,
  createPace,
  type PaceLimits,
} from "./pace.ts";

/** A clock that moves only when the pace waits, so a test reads exact times; a turn's deadline passes at once when `late`, never otherwise. */
function fakeClock(late = false) {
  let time = 0;
  return {
    after: () =>
      late ? Promise.resolve() : new Promise<void>(() => undefined),
    now: () => time,
    wait: async (ms: number) => {
      await Promise.resolve();
      time += ms;
    },
  };
}

/** A render that records when it started and ends when told. */
function held(clock: { now: () => number }, starts: number[], answer = "done") {
  let end: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    end,
    render: async () => {
      starts.push(clock.now());
      await ended;
      return answer;
    },
  };
}

type Lane = "a" | "b";

function limits(
  gapMs: number,
  waiting: Record<Lane, number>,
  overrun = 2,
  burst = 1
): PaceLimits<Lane> {
  return { burst, gapMs, overrun, turnMs: 5000, waiting };
}

/** Lets every pending turn of the event loop run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn lets the next settle
    await Promise.resolve();
  }
}

describe("the render pace", () => {
  test("renders run one at a time, each starting at least the gap after the one before", async () => {
    const clock = fakeClock();
    const pace = createPace(limits(250, { a: 5, b: 5 }), clock);
    const starts: number[] = [];
    const answers = await Promise.all(
      [1, 2, 3].map(() =>
        pace.run("a", async () => {
          starts.push(clock.now());
          await clock.wait(40);
          return "done";
        })
      )
    );
    expect(answers).toEqual(["done", "done", "done"]);
    expect(starts).toEqual([0, 250, 500]);
  });

  test("a burst runs without a gap as far as it has saved up, one a gap after that, and saves up again while idle", async () => {
    const clock = fakeClock();
    const pace = createPace(limits(500, { a: 10, b: 10 }, 2, 3), clock);
    const starts: number[] = [];
    const run = () =>
      pace.run("a", () => {
        starts.push(clock.now());
        return Promise.resolve("done");
      });
    await Promise.all([1, 2, 3, 4, 5].map(run));
    expect(starts).toEqual([0, 0, 0, 500, 1000]);
    await clock.wait(1500);
    await Promise.all([1, 2, 3, 4].map(run));
    expect(starts.slice(5)).toEqual([2500, 2500, 2500, 3000]);
  });

  test("a render waits for the one before it to end, within that one's turn, whatever lane either is in", async () => {
    const clock = fakeClock();
    const pace = createPace(limits(100, { a: 5, b: 5 }), clock);
    const starts: number[] = [];
    const first = held(clock, starts);
    const one = pace.run("a", first.render);
    const two = pace.run("b", () => {
      starts.push(clock.now());
      return Promise.resolve("second");
    });
    await settle();
    await clock.wait(1000);
    expect(starts).toEqual([0]);
    first.end();
    expect(await one).toBe("done");
    expect(await two).toBe("second");
    expect(starts).toHaveLength(2);
  });

  test("the lanes take turns: a lane full of waiting renders lets another lane's render go next", async () => {
    const clock = fakeClock();
    const pace = createPace(limits(0, { a: 10, b: 10 }), clock);
    const order: string[] = [];
    const first = held(clock, []);
    const running = pace.run("a", first.render);
    const flood = [1, 2, 3, 4].map((i) =>
      pace.run("a", () => {
        order.push(`a${i}`);
        return Promise.resolve("a");
      })
    );
    const other = pace.run("b", () => {
      order.push("b");
      return Promise.resolve("b");
    });
    first.end();
    await Promise.all([running, ...flood, other]);
    expect(order[0]).toBe("b");
  });

  test("a lane past its waiting room refuses its render, which never runs, and another lane still has room", async () => {
    const clock = fakeClock();
    const pace = createPace(limits(0, { a: 1, b: 1 }), clock);
    const first = held(clock, []);
    const running = pace.run("a", first.render);
    const waiting = pace.run("a", () => Promise.resolve("a"));
    let ran = false;
    const refused = await pace.run("a", () => {
      ran = true;
      return Promise.resolve("refused");
    });
    expect(refused).toBeUndefined();
    expect(ran).toBe(false);
    const other = pace.run("b", () => Promise.resolve("b"));
    first.end();
    expect(await running).toBe("done");
    expect(await waiting).toBe("a");
    expect(await other).toBe("b");
  });

  test("a render still running when its turn's deadline passes gives up its slot: the next starts and never waits on it", async () => {
    const clock = fakeClock(true);
    const pace = createPace(limits(100, { a: 1, b: 1 }), clock);
    const starts: number[] = [];
    const wedged = held(clock, starts);
    const stuck = pace.run("a", wedged.render);
    const next = pace.run("a", () => {
      starts.push(clock.now());
      return Promise.resolve("next");
    });
    expect(await next).toBe("next");
    expect(starts).toEqual([0, 100]);
    wedged.end();
    expect(await stuck).toBe("done");
  });

  test("past as many renders running on beyond their deadline as it allows, every lane refuses until one of them ends", async () => {
    const clock = fakeClock(true);
    const pace = createPace(limits(0, { a: 5, b: 5 }, 2), clock);
    const one = held(clock, [], "one");
    const two = held(clock, [], "two");
    const first = pace.run("a", one.render);
    const second = pace.run("b", two.render);
    await settle();
    expect(await pace.run("a", () => Promise.resolve("a"))).toBeUndefined();
    expect(await pace.run("b", () => Promise.resolve("b"))).toBeUndefined();
    one.end();
    expect(await first).toBe("one");
    expect(await pace.run("b", () => Promise.resolve("b"))).toBe("b");
    two.end();
    expect(await second).toBe("two");
  });

  test("a render that throws rejects its own caller and frees the turn for the next", async () => {
    const pace = createPace(limits(0, { a: 2, b: 2 }), fakeClock());
    const failed = pace.run("a", () =>
      Promise.reject(new Error("render failed"))
    );
    const next = pace.run("a", () => Promise.resolve("next"));
    await expect(failed).rejects.toThrow("render failed");
    expect(await next).toBe("next");
  });
});

describe("the answer to a render with no room", () => {
  test("is a 503 that asks to try again in a second, in plain text", async () => {
    const answer = busyAnswer();
    expect(answer.status).toBe(503);
    expect(answer.headers.get("retry-after")).toBe("1");
    expect(answer.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.text()).toBe("Service Unavailable");
  });
});

describe("the body budget", () => {
  test("gives a place while the client is under its share and the total under its own, and each place back once", () => {
    const take = createBodyBudget({ perClient: 2, total: 4 });
    const first = take("a");
    const second = take("a");
    expect(first && second).toBeDefined();
    expect(take("a")).toBeUndefined();
    const other = take("b");
    expect(other).toBeDefined();
    first?.();
    first?.();
    // One place back, once: the client has room for exactly one more.
    const third = take("a");
    expect(third).toBeDefined();
    expect(take("a")).toBeUndefined();
    expect(take("c")).toBeDefined();
    expect(take("d")).toBeUndefined();
    second?.();
    third?.();
    other?.();
    expect(take("a") && take("a")).toBeDefined();
    expect(take("d")).toBeDefined();
    expect(take("e")).toBeUndefined();
  });
});
