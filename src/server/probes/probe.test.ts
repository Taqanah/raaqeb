import { afterEach, describe, expect, test } from "bun:test";
import { type LiveIo, liveIo } from "@/server/checks/io.ts";
import {
  assignmentsPath,
  type ProbeAssignments,
  probeResultsSchema,
  probeVersionHeader,
  resultsPath,
  roundTripHeader,
} from "@/shared/schemas/probe.ts";
import {
  createProbe,
  type ProbeProcess,
  probeTarget,
  pullPeriodMs,
  pushPeriodMs,
} from "./probe.ts";

/** What the fake install saw: each request's path, headers and body. */
interface Seen {
  readonly body: unknown;
  readonly headers: Headers;
  readonly method: string;
  readonly path: string;
}

let stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops) {
    // biome-ignore lint/performance/noAwaitInLoops: each server and probe in turn
    await stop();
  }
  stops = [];
});

/** A local target the checks reach, and a fake install whose assignments and answers the test sets. */
function world(resultsPerPush?: number) {
  const target = Bun.serve({
    fetch: () => new Response("hello"),
    hostname: "127.0.0.1",
    port: 0,
  });
  let assignments: ProbeAssignments = {
    monitors: [
      {
        config: {
          assertions: [{ codes: ["2xx"], kind: "status" }],
          captureMode: "off",
          followRedirects: true,
          ignoreTlsErrors: false,
          method: "GET",
          type: "http",
          url: `http://127.0.0.1:${target.port}/`,
        },
        id: "m1",
        intervalMs: 20_000,
        retries: 0,
        timeoutMs: 5000,
        updatedAt: 1,
      },
    ],
    protocol: 1,
  };
  let tag = '"one"';
  let resultsStatus = 200;
  const seen: Seen[] = [];
  const install = Bun.serve({
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() : undefined;
      seen.push({
        body,
        headers: request.headers,
        method: request.method,
        path,
      });
      if (path === assignmentsPath) {
        return request.headers.get("if-none-match") === tag
          ? new Response(null, { headers: { etag: tag }, status: 304 })
          : Response.json(assignments, { headers: { etag: tag } });
      }
      return resultsStatus === 200
        ? Response.json({ assignments: tag })
        : new Response(null, { status: resultsStatus });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  stops.push(async () => {
    await target.stop(true);
    await install.stop(true);
  });
  let clock = 1000;
  const io: LiveIo = { ...liveIo(), sleep: () => Promise.resolve() };
  const logs: string[] = [];
  const probe: ProbeProcess = createProbe({
    fetch,
    io,
    log: (line) => logs.push(line),
    monotonic: () => clock,
    ...(resultsPerPush !== undefined && { resultsPerPush }),
    server: `http://127.0.0.1:${install.port}`,
    token: "rqp_test",
    version: "0.3.0",
  });
  stops.push(() => probe.stop());
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    assignments: () => assignments,
    logs,
    probe,
    pushes: () =>
      seen
        .filter((each) => each.path === resultsPath)
        .map((each) => probeResultsSchema.parse(each.body)),
    seen,
    setAssignments: (next: ProbeAssignments, nextTag: string) => {
      assignments = next;
      tag = nextTag;
    },
    setResultsStatus: (status: number) => {
      resultsStatus = status;
    },
    setTag: (nextTag: string) => {
      tag = nextTag;
    },
  };
}

async function step(probe: ProbeProcess) {
  await probe.tick();
  await probe.idle();
}

describe("a probe", () => {
  test("pulls its assignments with its token and build, checks them, and pushes each result with its age, never a time of day", async () => {
    const w = world();
    await step(w.probe);
    const [pull] = w.seen;
    expect(pull?.path).toBe(assignmentsPath);
    expect(pull?.headers.get("authorization")).toBe("Bearer rqp_test");
    expect(pull?.headers.get(probeVersionHeader)).toBe("0.3.0");
    w.advance(1500);
    await step(w.probe);
    const [pushed] = w.pushes();
    expect(pushed?.results).toHaveLength(1);
    expect(pushed?.results[0]).toMatchObject({
      ageMs: 1500,
      monitorId: "m1",
      reason: "ok",
      result: "up",
      statusCode: 200,
    });
    expect(JSON.stringify(pushed)).not.toContain("startedAt");
  });

  test("sends its last request's round trip with the next one", async () => {
    const w = world();
    await step(w.probe);
    w.advance(pushPeriodMs);
    await step(w.probe);
    const pushed = w.seen.find((each) => each.path === resultsPath);
    expect(Number(pushed?.headers.get(roundTripHeader))).toBeGreaterThanOrEqual(
      0
    );
  });

  test("asks again with the tag it holds, and keeps its schedule when nothing changed", async () => {
    const w = world();
    await step(w.probe);
    w.advance(pullPeriodMs);
    await step(w.probe);
    const pulls = w.seen.filter((each) => each.path === assignmentsPath);
    expect(pulls).toHaveLength(2);
    expect(pulls[1]?.headers.get("if-none-match")).toBe('"one"');
  });

  test("holds only each monitor's latest result while the install does not take them", async () => {
    const w = world();
    w.setResultsStatus(503);
    await step(w.probe);
    w.advance(20_000);
    await step(w.probe);
    w.advance(20_000);
    await step(w.probe);
    w.setResultsStatus(200);
    w.advance(pushPeriodMs);
    await step(w.probe);
    const last = w.pushes().at(-1);
    expect(last?.results.map((each) => each.monitorId)).toEqual(["m1"]);
    expect(last?.results[0]?.ageMs).toBeLessThan(20_000);
  });

  test("a result held for a monitor that changed since its check is dropped, not pushed", async () => {
    const w = world();
    w.setResultsStatus(503);
    await step(w.probe);
    const [assigned] = w.assignments().monitors;
    if (!assigned) {
      throw new Error("no assignment");
    }
    w.setAssignments(
      { monitors: [{ ...assigned, updatedAt: 2 }], protocol: 1 },
      '"two"'
    );
    w.advance(pullPeriodMs);
    w.setResultsStatus(200);
    await w.probe.tick();
    expect(w.pushes()).toEqual([]);
  });

  test("a result the install took is not pushed again", async () => {
    const w = world();
    await step(w.probe);
    w.advance(pushPeriodMs);
    await step(w.probe);
    w.advance(pushPeriodMs);
    await step(w.probe);
    expect(w.pushes()).toHaveLength(1);
  });

  test("a push answered with a new tag pulls the assignments at once, and a monitor no longer assigned is no longer checked", async () => {
    const w = world();
    await step(w.probe);
    w.setAssignments({ monitors: [], protocol: 1 }, '"two"');
    w.advance(pushPeriodMs);
    await step(w.probe);
    await step(w.probe);
    const pulls = w.seen.filter((each) => each.path === assignmentsPath);
    expect(pulls).toHaveLength(2);
    w.advance(20_000);
    await step(w.probe);
    w.advance(pushPeriodMs);
    await step(w.probe);
    expect(w.pushes()).toHaveLength(1);
  });
});

describe("a probe's pushes", () => {
  test("go out no larger than the results one push may carry", async () => {
    const w = world(1);
    const [first] = w.assignments().monitors;
    if (!first) {
      throw new Error("no assignment");
    }
    w.setAssignments(
      { monitors: [first, { ...first, id: "m2" }], protocol: 1 },
      '"two"'
    );
    // The install takes nothing until both results are held; the second monitor runs half the spread later.
    w.setResultsStatus(503);
    await step(w.probe);
    w.advance(16_000);
    await step(w.probe);
    w.setResultsStatus(200);
    w.advance(pushPeriodMs);
    const before = w.pushes().length;
    await step(w.probe);
    expect(
      w
        .pushes()
        .slice(before)
        .map((each) => each.results.length)
    ).toEqual([1, 1]);
  });

  test("an answer that is not 200 is logged, a 429 among them", async () => {
    const w = world();
    w.setResultsStatus(429);
    await step(w.probe);
    w.advance(pushPeriodMs);
    await step(w.probe);
    expect(w.logs.some((line) => line.includes("429"))).toBe(true);
  });
});

describe("where a probe reports", () => {
  test("needs the install's address and a token, naming the variable that is missing", () => {
    expect(probeTarget({})).toEqual({
      message: expect.stringContaining("RAAQEB_PROBE_SERVER"),
      ok: false,
    });
    expect(
      probeTarget({ RAAQEB_PROBE_SERVER: "https://status.example.test" })
    ).toEqual({
      message: expect.stringContaining("RAAQEB_PROBE_TOKEN"),
      ok: false,
    });
  });

  test("an https address, or http on the loopback, is taken as its origin", () => {
    expect(
      probeTarget({
        RAAQEB_PROBE_SERVER: "https://status.example.test/",
        RAAQEB_PROBE_TOKEN: "rqp_x",
      })
    ).toEqual({
      ok: true,
      server: "https://status.example.test",
      token: "rqp_x",
    });
    expect(
      probeTarget({
        RAAQEB_PROBE_SERVER: "http://127.0.0.1:3000",
        RAAQEB_PROBE_TOKEN: "rqp_x",
      }).ok
    ).toBe(true);
    expect(
      probeTarget({
        RAAQEB_PROBE_SERVER: "http://localhost:3000",
        RAAQEB_PROBE_TOKEN: "rqp_x",
      }).ok
    ).toBe(true);
  });

  test("plain http to another host is refused, since the token and shared credentials would cross in clear", () => {
    const refused = probeTarget({
      RAAQEB_PROBE_SERVER: "http://status.example.test",
      RAAQEB_PROBE_TOKEN: "rqp_x",
    });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("status.example.test");
    expect(JSON.stringify(refused)).not.toContain("rqp_x");
  });
});
