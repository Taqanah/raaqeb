import { afterEach, describe, expect, test } from "bun:test";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { scratchPages } from "@/server/pages/fixture.ts";
import {
  assignmentsPath,
  type ProbeAssignments,
  type ProbeResult,
  probeReceiptSchema,
  probeVersionHeader,
  resultsMax,
  resultsPath,
  roundTripHeader,
} from "@/shared/schemas/probe.ts";
import {
  answerAssignments,
  answerResults,
  contactWriteMs,
  createProbeGate,
  type ProbeApiContext,
  probeRequestsPerMinute,
  refusalAddressesMax,
  refusalsPerMinute,
} from "./api.ts";
import { makeProbe } from "./probes.ts";

let scratch: Awaited<ReturnType<typeof scratchPages>> | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const assignments: ProbeAssignments = {
  monitors: [
    {
      config: { host: "db.example.test", port: 5432, type: "tcp" },
      id: "m1",
      intervalMs: 60_000,
      retries: 0,
      timeoutMs: 5000,
      updatedAt: 1,
    },
  ],
  protocol: 1,
};

const saw: ProbeResult = {
  ageMs: 1500,
  attempts: 1,
  bytes: 0,
  monitorId: "m1",
  reason: "ok",
  responseMs: 12,
  result: "up",
};

/** An install with one probe, a scheduler that answers fixed assignments and records the reports, and a clock the test moves. */
async function install() {
  scratch = await scratchPages();
  const { storage } = scratch;
  const made = await makeProbe(storage, "Frankfurt");
  if (!made.ok) {
    throw new Error("no probe made");
  }
  const reports: {
    probeId: string;
    receivedAt: number;
    results: readonly ProbeResult[];
  }[] = [];
  let now = 1_700_000_000_000;
  const gate = createProbeGate();
  const context = (): ProbeApiContext => ({
    gate,
    now,
    scheduler: {
      assignmentsOf: (probeId) =>
        probeId === made.probe.id ? assignments : undefined,
      report: (probeId, results, receivedAt) => {
        reports.push({ probeId, receivedAt, results });
      },
    },
    storage,
  });
  return {
    advance: (ms: number) => {
      now += ms;
    },
    context,
    probe: made.probe,
    reports,
    storage,
    token: made.token,
  };
}

const request = (
  path: string,
  token: string | undefined,
  init: RequestInit = {},
  address = "203.0.113.7"
) =>
  new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: {
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
      [clientAddressHeader]: address,
      [probeVersionHeader]: "0.3.0",
      [roundTripHeader]: "37",
      ...init.headers,
    },
  });

const push = (token: string, body: unknown, address?: string) =>
  request(
    resultsPath,
    token,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    address
  );

describe("the probe API", () => {
  test("a probe's token answers its own assignments, with a tag that answers 304 while they stand", async () => {
    const it = await install();
    const answer = await answerAssignments(
      it.context(),
      request(assignmentsPath, it.token)
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual(assignments);
    const tag = answer.headers.get("etag");
    expect(tag).toBeTruthy();
    const again = await answerAssignments(
      it.context(),
      request(assignmentsPath, it.token, {
        headers: { "if-none-match": tag ?? "" },
      })
    );
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  test("no token or a wrong one is 401 with the bearer challenge and nothing read", async () => {
    const it = await install();
    for (const token of [undefined, "rqp_wrong"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one request after another
      const answer = await answerAssignments(
        it.context(),
        request(assignmentsPath, token)
      );
      expect(answer.status).toBe(401);
      expect(answer.headers.get("www-authenticate")).toBe("Bearer");
      expect(await answer.text()).toBe("");
    }
  });

  test("a probe's results are handed to the scheduler as received now, and the answer names the assignments' tag", async () => {
    const it = await install();
    const tag = (
      await answerAssignments(it.context(), request(assignmentsPath, it.token))
    ).headers.get("etag");
    const answer = await answerResults(
      it.context(),
      push(it.token, { results: [saw] })
    );
    expect(answer.status).toBe(200);
    expect(probeReceiptSchema.parse(await answer.json())).toEqual({
      assignments: tag ?? "",
      dropped: 0,
    });
    expect(it.reports).toEqual([
      { probeId: it.probe.id, receivedAt: 1_700_000_000_000, results: [saw] },
    ]);
  });

  test("a push whose body is no list of results is 400 and reports nothing", async () => {
    const it = await install();
    const answer = await answerResults(
      it.context(),
      push(it.token, { results: "sideways" })
    );
    expect(answer.status).toBe(400);
    const broken = await answerResults(
      it.context(),
      request(resultsPath, it.token, { body: "{", method: "POST" })
    );
    expect(broken.status).toBe(400);
    expect(it.reports).toEqual([]);
  });

  test("a probe's contact is written with its build and round trip, at most every 30 seconds", async () => {
    const it = await install();
    await answerAssignments(it.context(), request(assignmentsPath, it.token));
    const [first] = await it.storage.probes.list();
    expect(first).toMatchObject({
      lastSeenAt: 1_700_000_000_000,
      roundTripMs: 37,
      version: "0.3.0",
    });
    it.advance(contactWriteMs - 1);
    await answerAssignments(it.context(), request(assignmentsPath, it.token));
    expect((await it.storage.probes.list())[0]?.lastSeenAt).toBe(
      1_700_000_000_000
    );
    it.advance(1);
    await answerAssignments(it.context(), request(assignmentsPath, it.token));
    expect((await it.storage.probes.list())[0]?.lastSeenAt).toBe(
      1_700_000_000_000 + contactWriteMs
    );
  });

  test("a new build is written at once", async () => {
    const it = await install();
    await answerAssignments(it.context(), request(assignmentsPath, it.token));
    it.advance(1000);
    await answerAssignments(
      it.context(),
      request(assignmentsPath, it.token, {
        headers: { [probeVersionHeader]: "0.4.0" },
      })
    );
    expect((await it.storage.probes.list())[0]?.version).toBe("0.4.0");
  });

  test("a probe past its requests a minute is 429 with a wait, and is heard again a minute later", async () => {
    const it = await install();
    for (let sent = 0; sent < probeRequestsPerMinute; sent += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one request after another
      const heard = await answerAssignments(
        it.context(),
        request(assignmentsPath, it.token)
      );
      expect(heard.status).toBe(200);
    }
    const refused = await answerAssignments(
      it.context(),
      request(assignmentsPath, it.token)
    );
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    it.advance(60_000);
    expect(
      (
        await answerAssignments(
          it.context(),
          request(assignmentsPath, it.token)
        )
      ).status
    ).toBe(200);
  });

  test("an address that keeps sending wrong tokens is answered 429 for the next wrong one, and a probe's own token from it is still heard", async () => {
    const it = await install();
    for (let sent = 0; sent < refusalsPerMinute; sent += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one request after another
      await answerAssignments(
        it.context(),
        request(assignmentsPath, "rqp_wrong")
      );
    }
    expect(
      (
        await answerAssignments(
          it.context(),
          request(assignmentsPath, "rqp_wrong")
        )
      ).status
    ).toBe(429);
    expect(
      (
        await answerAssignments(
          it.context(),
          request(assignmentsPath, it.token)
        )
      ).status
    ).toBe(200);
  });

  test("addresses in one IPv6 /64 count as one, and the counts hold a bounded number of addresses", () => {
    const gate = createProbeGate();
    for (let sent = 0; sent < refusalsPerMinute; sent += 1) {
      gate.refused(`2001:db8:1:2::${sent.toString(16)}`, 0);
    }
    expect(gate.barred("2001:db8:1:2::ffff", 0)).toBe(true);
    expect(gate.barred("2001:db8:1:3::1", 0)).toBe(false);
    for (let at = 0; at < refusalAddressesMax * 2; at += 1) {
      gate.refused(
        `10.${Math.floor(at / 65_536)}.${Math.floor(at / 256) % 256}.${at % 256}`,
        0
      );
    }
    expect(gate.tracked()).toBe(refusalAddressesMax);
  });

  test("an address is barred for the minute after its tenth wrong token and heard again when the minute ends", () => {
    const gate = createProbeGate();
    for (let sent = 0; sent < refusalsPerMinute; sent += 1) {
      gate.refused("203.0.113.7", 1000);
    }
    expect(gate.barred("203.0.113.7", 1000 + 59_999)).toBe(true);
    expect(gate.barred("203.0.113.7", 1000 + 60_000)).toBe(false);
  });

  test("a minute on, the counts of addresses that went quiet are dropped, and the oldest address goes first once the bound is reached", () => {
    const gate = createProbeGate();
    gate.refused("203.0.113.1", 0);
    gate.refused("203.0.113.2", 0);
    gate.refused("203.0.113.3", 60_000);
    expect(gate.tracked()).toBe(1);
    for (let sent = 0; sent < refusalsPerMinute; sent += 1) {
      gate.refused("198.51.100.1", 70_000);
    }
    expect(gate.barred("198.51.100.1", 70_000)).toBe(true);
    for (let at = 0; at < refusalAddressesMax; at += 1) {
      gate.refused(`10.0.${Math.floor(at / 256)}.${at % 256}`, 70_000);
    }
    expect(gate.barred("198.51.100.1", 70_000)).toBe(false);
  });

  test("an IPv6 address is keyed by its first four groups however it is written", () => {
    const gate = createProbeGate();
    for (let sent = 0; sent < refusalsPerMinute; sent += 1) {
      gate.refused("2001::1:2:3:4:5", 0);
    }
    expect(gate.barred("2001:0:0:1:ffff:0:0:9", 0)).toBe(true);
    expect(gate.barred("2001::9:2:3:4:5", 0)).toBe(false);
  });

  test("each result is judged on its own: a reason this install does not know is taken as unknown, a status code up to 999 as reported, one that fits no rule is dropped, and the answer counts the dropped", async () => {
    const it = await install();
    const answer = await answerResults(
      it.context(),
      push(it.token, {
        results: [
          { ...saw, reason: "from_a_newer_probe", result: "down" },
          { ...saw, monitorId: "m2", statusCode: 999 },
          { ...saw, monitorId: "m3", result: "sideways" },
        ],
      })
    );
    expect(answer.status).toBe(200);
    expect(probeReceiptSchema.parse(await answer.json()).dropped).toBe(1);
    expect(it.reports[0]?.results).toEqual([
      { ...saw, reason: "unknown", result: "down" },
      { ...saw, monitorId: "m2", statusCode: 999 },
    ]);
  });

  test("past the results one push may carry, the rest are dropped and counted", async () => {
    const it = await install();
    const answer = await answerResults(
      it.context(),
      push(it.token, {
        results: Array.from({ length: resultsMax + 2 }, () => saw),
      })
    );
    expect(probeReceiptSchema.parse(await answer.json()).dropped).toBe(2);
    expect(it.reports[0]?.results).toHaveLength(resultsMax);
  });

  test("a push refused whole marks the probe as refused until one is taken", async () => {
    const it = await install();
    const { gate } = it.context();
    await answerResults(
      it.context(),
      request(resultsPath, it.token, { body: "{", method: "POST" })
    );
    expect(gate.refusedPush(it.probe.id)).toBe(true);
    await answerResults(it.context(), push(it.token, { results: [saw] }));
    expect(gate.refusedPush(it.probe.id)).toBe(false);
  });

  test("a round trip is stored when it is a whole number of milliseconds under ten minutes, and as none otherwise", async () => {
    const it = await install();
    const stored = async (said: string) => {
      it.advance(contactWriteMs);
      await answerAssignments(
        it.context(),
        request(assignmentsPath, it.token, {
          headers: { [roundTripHeader]: said },
        })
      );
      return (await it.storage.probes.list())[0]?.roundTripMs;
    };
    expect(await stored("0")).toBe(0);
    expect(await stored("599999")).toBe(599_999);
    expect(await stored("600000")).toBeUndefined();
    expect(await stored("-5")).toBeUndefined();
    expect(await stored("12.5")).toBeUndefined();
    expect(await stored("fast")).toBeUndefined();
  });

  test("a request with no round trip stores none", async () => {
    const it = await install();
    await answerAssignments(
      it.context(),
      request(assignmentsPath, it.token, {
        headers: { [roundTripHeader]: "" },
      })
    );
    expect((await it.storage.probes.list())[0]?.roundTripMs).toBeUndefined();
  });

  test("a database that does not answer is 503, never an error out of the route", async () => {
    const it = await install();
    const answer = await answerAssignments(
      {
        ...it.context(),
        storage: {
          probes: {
            ...it.storage.probes,
            byTokenHash: () => Promise.reject(new Error("down")),
          },
        },
      },
      request(assignmentsPath, it.token)
    );
    expect(answer.status).toBe(503);
  });

  test("results pushed before the scheduler knows the probe are answered 503 and reported to nobody", async () => {
    const it = await install();
    const none = await answerResults(
      { ...it.context(), scheduler: undefined },
      push(it.token, { results: [saw] })
    );
    expect(none.status).toBe(503);
    const reported: string[] = [];
    const unknown = await answerResults(
      {
        ...it.context(),
        scheduler: {
          assignmentsOf: () => undefined,
          report: (probeId) => {
            reported.push(probeId);
          },
        },
      },
      push(it.token, { results: [saw] })
    );
    expect(unknown.status).toBe(503);
    expect(reported).toEqual([]);
  });

  test("before a database or a scheduler there is nothing to answer", async () => {
    const it = await install();
    const none = await answerAssignments(
      { ...it.context(), storage: undefined },
      request(assignmentsPath, it.token)
    );
    expect(none.status).toBe(404);
    const waiting = await answerAssignments(
      { ...it.context(), scheduler: undefined },
      request(assignmentsPath, it.token)
    );
    expect(waiting.status).toBe(503);
  });
});
