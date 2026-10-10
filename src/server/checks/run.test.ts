import { describe, expect, test } from "bun:test";
import type { Monitor, MonitorConfig } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import type { LiveIo } from "./io.ts";
import { runCheck } from "./run.ts";

const t0 = 1_700_000_000_000;

function monitor(config: MonitorConfig): Monitor {
  return {
    config,
    createdAt: t0,
    id: "m1",
    intervalMs: 60_000,
    name: "m1",
    paused: false,
    retries: 0,
    channels: [],
    events: [...monitorEventKinds],
    tags: [],
    target: undefined,
    timeoutMs: 10_000,
    updatedAt: t0,
  };
}

function io() {
  const used: string[] = [];
  const live: LiveIo = {
    connect: () => {
      used.push("connect");
      return Promise.resolve("192.0.2.1");
    },
    fetch: ((input: string | URL | Request) => {
      used.push(`fetch ${String(input)}`);
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch,
    now: () => t0,
    queryDatabase: () => {
      used.push("queryDatabase");
      return Promise.resolve(1);
    },
    readTls: () => Promise.reject(new Error("not in this test")),
    requestDocker: () => {
      used.push("requestDocker");
      return Promise.resolve({
        body: { message: "No such container: web" },
        status: 404,
      });
    },
    resolve: () => {
      used.push("resolve");
      return Promise.resolve(["192.0.2.1"]);
    },
    sleep: () => Promise.resolve(),
  };
  return { live, used };
}

describe("one check of any monitor", () => {
  test("an HTTP monitor runs the HTTP check over fetch", async () => {
    const { live, used } = io();
    const outcome = await runCheck(
      monitor({
        assertions: [{ codes: ["2xx"], kind: "status" }],
        captureMode: "off",
        followRedirects: true,
        ignoreTlsErrors: false,
        method: "GET",
        type: "http",
        url: "https://example.test/",
      }),
      live
    );
    expect(used).toEqual(["fetch https://example.test/"]);
    expect(outcome?.check.result).toBe("up");
    expect(outcome?.check.reason).toBe(reasons.ok);
  });

  test("a TCP monitor runs the TCP check over connect", async () => {
    const { live, used } = io();
    const outcome = await runCheck(
      monitor({ host: "db.example.test", port: 5432, type: "tcp" }),
      live
    );
    expect(used).toEqual(["connect"]);
    expect(outcome?.check.result).toBe("up");
  });

  test("a DNS monitor runs the DNS check over resolve", async () => {
    const { live, used } = io();
    const outcome = await runCheck(
      monitor({ name: "example.test", recordType: "A", type: "dns" }),
      live
    );
    expect(used).toEqual(["resolve"]);
    expect(outcome?.check.result).toBe("up");
  });

  test("a Postgres, MySQL or Redis monitor runs the database check over its query, with its connection URL", async () => {
    for (const type of ["postgres", "mysql", "redis"] as const) {
      const { live, used } = io();
      // biome-ignore lint/performance/noAwaitInLoops: one check type at a time
      const outcome = await runCheck(
        {
          ...monitor({ type }),
          credentials: { headers: [], url: `${type}://db.example.test` },
        },
        live
      );
      expect(used).toEqual(["queryDatabase"]);
      expect(outcome?.check.result).toBe("up");
    }
  });

  test("a Docker monitor runs the Docker check over a request to the daemon", async () => {
    const { live, used } = io();
    const outcome = await runCheck(
      monitor({
        container: "web",
        endpoint: "/var/run/docker.sock",
        type: "docker",
      }),
      live
    );
    expect(used).toEqual(["requestDocker"]);
    expect(outcome?.check.reason).toBe(reasons.container_not_found);
  });

  test("a heartbeat monitor has no check to run", () => {
    const { live, used } = io();
    expect(
      runCheck(
        monitor({
          schedule: { everyMs: 3_600_000, kind: "every" },
          type: "heartbeat",
        }),
        live
      )
    ).toBeUndefined();
    expect(used).toEqual([]);
  });
});
