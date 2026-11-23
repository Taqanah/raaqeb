/**
 * The render pace (CONTEXT.md "Render pace"): a full render of the app keeps
 * memory the allocator gives back only once renders slow down, so the entry
 * runs a stranger's renders one at a time, a gap apart, taking turns between
 * lanes, one per kind of page, so a flood of one kind waits behind itself
 * alone. A render past its lane's waiting room, or while too many renders run
 * past their deadline, is refused, and the entry answers 503. A request with
 * a session is never paced.
 */

/** How far apart renders start, how long one may hold its turn, how many may run on past it, and how many may wait in each lane. */
export interface PaceLimits<Lane extends string> {
  /** How many renders may start with no gap after an idle spell: one turn saved up for each gap that passed, at most this many. */
  readonly burst: number;
  readonly gapMs: number;
  /** Renders still running past their turn's deadline; past this many, every lane refuses until one ends. */
  readonly overrun: number;
  readonly turnMs: number;
  readonly waiting: Readonly<Record<Lane, number>>;
}

export interface Pace<Lane extends string> {
  /** Runs `render` when its lane's turn comes; nothing, and `render` never runs, when there is no room for it. */
  readonly run: <T>(
    lane: Lane,
    render: () => Promise<T>
  ) => Promise<T | undefined>;
}

/** The clock a pace waits on, which a test replaces. */
export interface PaceClock {
  /** Settles when a turn's deadline passes. */
  readonly after: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
}

const realClock: PaceClock = {
  after: (ms) => Bun.sleep(ms),
  now: performance.now.bind(performance),
  wait: (ms) => Bun.sleep(ms),
};

/** The pace over a clock. */
export function createPace<Lane extends string>(
  limits: PaceLimits<Lane>,
  clock: PaceClock = realClock
): Pace<Lane> {
  const lanes = Object.keys(limits.waiting) as Lane[];
  const queues = new Map<Lane, (() => void)[]>(lanes.map((lane) => [lane, []]));
  let busy = false;
  let overrunning = 0;
  // Turns saved up: one more for every gap that passes, at most the burst; a start spends one.
  let saved = limits.burst;
  let savedAt = clock.now();
  // The lane whose render went last: the next turn looks at the lanes after it first.
  let last = lanes.length - 1;

  const ignore = () => undefined;

  /** Adds the turns the gaps since the last count saved up. */
  const save = () => {
    const now = clock.now();
    saved =
      limits.gapMs > 0
        ? Math.min(limits.burst, saved + (now - savedAt) / limits.gapMs)
        : limits.burst;
    savedAt = now;
  };

  /** The next waiting render, the lanes taking turns: the lanes after the last one served come first. */
  const take = (): (() => void) | undefined => {
    for (let step = 1; step <= lanes.length; step += 1) {
      const index = (last + step) % lanes.length;
      const start = queues.get(lanes[index] as Lane)?.shift();
      if (start) {
        last = index;
        return start;
      }
    }
  };

  /** Starts the next waiting render, at least the gap after the one before, once no render holds the turn. */
  const next = (): void => {
    if (busy) {
      return;
    }
    const start = take();
    if (!start) {
      return;
    }
    busy = true;
    const launch = () => {
      save();
      saved -= 1;
      start();
    };
    save();
    const due = saved >= 1 ? 0 : (1 - saved) * limits.gapMs;
    if (due > 0) {
      clock.wait(due).then(launch, launch);
    } else {
      launch();
    }
  };

  /** Frees the turn once: when the render ends, or at its deadline if it runs on, which counts it as running past its deadline until it ends. */
  const turn = (answer: Promise<unknown>) => {
    let free = true;
    let ended = false;
    let late = false;
    const release = () => {
      if (free) {
        free = false;
        busy = false;
        next();
      }
    };
    const end = () => {
      ended = true;
      if (late) {
        overrunning -= 1;
      }
      release();
    };
    answer.then(end, end);
    clock.after(limits.turnMs).then(() => {
      if (!ended) {
        late = true;
        overrunning += 1;
        release();
      }
    }, ignore);
  };

  return {
    run: <T>(lane: Lane, render: () => Promise<T>): Promise<T | undefined> => {
      const queue = queues.get(lane) ?? [];
      if (
        overrunning >= limits.overrun ||
        queue.length >= (limits.waiting[lane] ?? 0) + (busy ? 0 : 1)
      ) {
        return Promise.resolve(undefined);
      }
      return new Promise<T | undefined>((resolve, reject) => {
        queue.push(() => {
          const answer = render();
          answer.then(resolve, reject);
          turn(answer);
        });
        next();
      });
    },
  };
}

/** The answer to a render there was no room for: try again in a second. */
export function busyAnswer(): Response {
  return new Response("Service Unavailable", {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "1",
    },
    status: 503,
  });
}

/** How many of a stranger's requests carrying a body may be in flight at once: in all, and from one client network, so one client's flood leaves the others room. */
export interface BodyLimits {
  readonly perClient: number;
  readonly total: number;
}

/** A place for one more request from `client`, with the function that gives it back, once; nothing when there is no room. */
export type BodyBudget = (client: string) => (() => void) | undefined;

/** The body budget over its limits. */
export function createBodyBudget(limits: BodyLimits): BodyBudget {
  let total = 0;
  // Only clients holding a place, so the table never outgrows the total.
  const held = new Map<string, number>();
  return (client) => {
    const mine = held.get(client) ?? 0;
    if (total >= limits.total || mine >= limits.perClient) {
      return;
    }
    total += 1;
    held.set(client, mine + 1);
    let given = false;
    return () => {
      if (given) {
        return;
      }
      given = true;
      total -= 1;
      const left = (held.get(client) ?? 1) - 1;
      if (left === 0) {
        held.delete(client);
      } else {
        held.set(client, left);
      }
    };
  };
}
