import { afterEach, describe, expect, test } from "bun:test";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import {
  heartbeatBodyReadBytes,
  heartbeatResponse,
  readBodyHead,
  readHeartbeatCall,
  receiveHeartbeat,
} from "./heartbeat.ts";

let open:
  | {
      storage: Storage;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

async function storage(): Promise<{
  location: DatabaseLocation;
  storage: Storage;
}> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = {
    cleanup: scratch.cleanup,
    location: scratch.location,
    storage: opened.storage,
  };
  return { location: scratch.location, storage: opened.storage };
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

const beat: MonitorInput = {
  config: {
    schedule: { everyMs: 300_000, kind: "every" },
    type: "heartbeat",
  },
  intervalMs: 60_000,
  name: "Backup",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 10_000,
};

const t0 = 1_700_000_000_000;

async function heartbeatMonitor(
  store: Storage
): Promise<{ id: string; token: string }> {
  const { id } = await store.monitors.create(beat);
  const token = await store.monitors.heartbeatTokenOf(id);
  if (token === undefined) {
    throw new Error("a heartbeat monitor without a token");
  }
  return { id, token };
}

async function heartbeatRows(location: DatabaseLocation) {
  return await runSql(
    location,
    "SELECT monitor_id, arrived_at, source_ip FROM heartbeats"
  );
}

describe("a call to a heartbeat monitor's URL", () => {
  test("a known token stores the heartbeat with its arrival time and source address", async () => {
    const { location, storage: store } = await storage();
    const { id, token } = await heartbeatMonitor(store);
    expect(await receiveHeartbeat(store, token, "203.0.113.7", t0)).toBe(
      "recorded"
    );
    const rows = await heartbeatRows(location);
    expect(
      rows.map((row) => [row.monitor_id, Number(row.arrived_at), row.source_ip])
    ).toEqual([[id, t0, "203.0.113.7"]]);
  });

  test("an unknown token, or text that is not a token, stores nothing", async () => {
    const { location, storage: store } = await storage();
    await heartbeatMonitor(store);
    expect(await receiveHeartbeat(store, "A".repeat(22), undefined, t0)).toBe(
      "unknown"
    );
    expect(await receiveHeartbeat(store, "not a token", undefined, t0)).toBe(
      "unknown"
    );
    expect(await heartbeatRows(location)).toEqual([]);
  });

  test("text that is not a token never reaches the database", async () => {
    let asked = false;
    const watching: Pick<Storage, "heartbeats"> = {
      heartbeats: {
        latest: () => Promise.resolve(new Map()),
        prune: () => Promise.resolve(),
        lastFailures: () => Promise.resolve(new Map()),
        recent: () => Promise.resolve([]),
        record: () => {
          asked = true;
          return Promise.resolve(undefined);
        },
      },
    };
    expect(
      await receiveHeartbeat(watching, "../../etc/passwd", undefined, t0)
    ).toBe("unknown");
    expect(asked).toBe(false);
    await receiveHeartbeat(watching, "A".repeat(22), undefined, t0);
    expect(asked).toBe(true);
  });

  test("a paused monitor's heartbeat is stored; the job is never told about a pause", async () => {
    const { location, storage: store } = await storage();
    const { id, token } = await heartbeatMonitor(store);
    await store.monitors.pause([id]);
    expect(await receiveHeartbeat(store, token, undefined, t0)).toBe(
      "recorded"
    );
    expect(await heartbeatRows(location)).toHaveLength(1);
  });

  test("no open database answers unavailable, as does one that fails", async () => {
    expect(
      await receiveHeartbeat(undefined, "A".repeat(22), undefined, t0)
    ).toBe("unavailable");
    const { storage: store } = await storage();
    const { token } = await heartbeatMonitor(store);
    const failing: Pick<Storage, "heartbeats"> = {
      heartbeats: {
        ...store.heartbeats,
        record: () => Promise.reject(new Error("database gone")),
      },
    };
    expect(await receiveHeartbeat(failing, token, undefined, t0)).toBe(
      "unavailable"
    );
  });

  test("a heartbeat moves no change counter: arrivals are not public content, the check that counts them is", async () => {
    const { storage: store } = await storage();
    const { token } = await heartbeatMonitor(store);
    const before = await store.changeCounter();
    await receiveHeartbeat(store, token, undefined, t0);
    expect(await store.changeCounter()).toBe(before);
  });
});

describe("the answer to the job", () => {
  test("a stored heartbeat is 200 OK as plain text, never cached", async () => {
    const response = heartbeatResponse("recorded", "GET");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
  });

  test("an unknown token is 404 Not Found and no database is 503 Service Unavailable, the HTTP reason phrases, both plain text and never cached", async () => {
    const unknown = heartbeatResponse("unknown", "POST");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("Not Found");
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(unknown.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
    const unavailable = heartbeatResponse("unavailable", "GET");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe("Service Unavailable");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
  });

  test("a HEAD gets the status and no body", async () => {
    const response = heartbeatResponse("recorded", "HEAD");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

const here = "http://raaqeb.test/api/heartbeat/token";

function call(query: string, init?: RequestInit): Request {
  return new Request(`${here}${query}`, init);
}

describe("what a call says of the job", () => {
  test("a plain call says the job ran", async () => {
    expect(await readHeartbeatCall(call(""), false)).toEqual({
      failure: undefined,
    });
  });

  test("the fail address says it failed, with no exit code and no message", async () => {
    expect(await readHeartbeatCall(call(""), true)).toEqual({
      failure: { exitCode: undefined, message: undefined },
    });
  });

  test("status=fail, or down as Uptime Kuma's push URLs say it, says it failed; ok and up say it ran", async () => {
    for (const status of ["fail", "down"]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: two calls
        await readHeartbeatCall(call(`?status=${status}`), false)
      ).toEqual({ failure: { exitCode: undefined, message: undefined } });
    }
    for (const status of ["ok", "up"]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: two calls
        await readHeartbeatCall(call(`?status=${status}`), false)
      ).toEqual({ failure: undefined });
    }
  });

  test("the status words are read whatever their case: FAIL and Down say it failed, OK and UP say it ran", async () => {
    for (const status of ["FAIL", "Fail", "DOWN", "Down"]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: a few calls
        await readHeartbeatCall(call(`?status=${status}`), false)
      ).toEqual({ failure: { exitCode: undefined, message: undefined } });
    }
    for (const status of ["OK", "Up", "UP"]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: a few calls
        await readHeartbeatCall(call(`?status=${status}`), false)
      ).toEqual({ failure: undefined });
    }
  });

  test("any other status is ignored, as every query was before: the call says the job ran", async () => {
    for (const status of ["", "1", "success", "failed", "ok%20fail"]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: a few calls
        await readHeartbeatCall(call(`?status=${status}`), false)
      ).toEqual({ failure: undefined });
    }
  });

  test("a nonzero exit code says it failed, and zero says nothing on its own", async () => {
    expect(await readHeartbeatCall(call("?exit=2"), false)).toEqual({
      failure: { exitCode: 2, message: undefined },
    });
    expect(await readHeartbeatCall(call("?exit=255"), false)).toEqual({
      failure: { exitCode: 255, message: undefined },
    });
    expect(await readHeartbeatCall(call("?exit=0"), false)).toEqual({
      failure: undefined,
    });
    expect(await readHeartbeatCall(call("?exit=0"), true)).toEqual({
      failure: { exitCode: 0, message: undefined },
    });
  });

  test("an exit code that is not a whole number from 0 to 255 is ignored: it says nothing and is not kept", async () => {
    for (const exit of ["", "256", "-1", "1.5", "abc", "0x1", "1e2", "٣"]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: a few calls
        await readHeartbeatCall(call(`?exit=${exit}`), false)
      ).toEqual({ failure: undefined });
      expect(await readHeartbeatCall(call(`?exit=${exit}`), true)).toEqual({
        failure: { exitCode: undefined, message: undefined },
      });
    }
  });

  test("a failure takes its message from the query, cleaned and cut", async () => {
    expect(
      await readHeartbeatCall(
        call("?status=fail&message=disk%20%20full%0Aon%20%2Fvar"),
        false
      )
    ).toEqual({
      failure: { exitCode: undefined, message: "disk full on /var" },
    });
    expect(
      await readHeartbeatCall(
        call(`?status=fail&message=${"x".repeat(5000)}`),
        false
      )
    ).toEqual({ failure: { exitCode: undefined, message: "x".repeat(256) } });
  });

  test("msg, as Uptime Kuma's push URLs name it, is the message too, and message wins", async () => {
    expect(
      await readHeartbeatCall(call("?status=down&msg=late"), false)
    ).toEqual({
      failure: { exitCode: undefined, message: "late" },
    });
    expect(
      await readHeartbeatCall(call("?status=down&msg=late&message=full"), false)
    ).toEqual({ failure: { exitCode: undefined, message: "full" } });
  });

  test("a message on a call that says the job ran is dropped", async () => {
    expect(await readHeartbeatCall(call("?message=hello"), false)).toEqual({
      failure: undefined,
    });
  });

  test("a POST's body is the message when the query has none", async () => {
    expect(
      await readHeartbeatCall(
        call("", { body: "backup.sh: no space left\n", method: "POST" }),
        true
      )
    ).toEqual({
      failure: { exitCode: undefined, message: "backup.sh: no space left" },
    });
    expect(
      await readHeartbeatCall(
        call("?message=from%20query", { body: "from body", method: "POST" }),
        true
      )
    ).toEqual({
      failure: { exitCode: undefined, message: "from query" },
    });
  });

  test("only the first kilobyte of a body is read, and an Arabic message cut at it stays whole text", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("ب".repeat(256));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 }
    );
    const said = await readHeartbeatCall(
      call("", { body, duplex: "half", method: "POST" } as RequestInit),
      true
    );
    expect(pulled).toBeLessThanOrEqual(
      heartbeatBodyReadBytes / chunk.length + 1
    );
    expect(said).toEqual({
      failure: { exitCode: undefined, message: "ب".repeat(256) },
    });
  });

  test("the body of a call that says the job ran is never read", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(10));
        },
      },
      { highWaterMark: 0 }
    );
    await readHeartbeatCall(
      call("", { body, duplex: "half", method: "POST" } as RequestInit),
      false
    );
    expect(pulled).toBe(0);
  });

  test("a body that is not text becomes a message of replacement characters, never a crash", async () => {
    const result = await readHeartbeatCall(
      call("", { body: new Uint8Array([0xff, 0xfe, 0x41]), method: "POST" }),
      true
    );
    expect(result).toEqual({
      failure: { exitCode: undefined, message: "\ufffd\ufffdA" },
    });
  });
});

describe("a call that reports failure", () => {
  test("is stored with its exit code and message, and marked failed", async () => {
    const { location, storage: store } = await storage();
    const { id, token } = await heartbeatMonitor(store);
    expect(
      await receiveHeartbeat(store, token, undefined, t0, {
        exitCode: 2,
        message: "disk full",
      })
    ).toBe("recorded");
    const rows = await runSql(
      location,
      "SELECT monitor_id, failed, exit_code, message FROM heartbeats"
    );
    expect(
      rows.map((row) => [
        row.monitor_id,
        Number(row.failed),
        row.exit_code === null ? null : Number(row.exit_code),
        row.message,
      ])
    ).toEqual([[id, 1, 2, "disk full"]]);
  });

  test("a heartbeat that says the job ran is stored not failed", async () => {
    const { location, storage: store } = await storage();
    const { token } = await heartbeatMonitor(store);
    await receiveHeartbeat(store, token, undefined, t0);
    const [row] = await runSql(
      location,
      "SELECT failed, exit_code, message FROM heartbeats"
    );
    expect([Number(row?.failed), row?.exit_code, row?.message]).toEqual([
      0,
      null,
      null,
    ]);
  });
});

describe("a monitor's heartbeats are bounded on every call", () => {
  test("a job failing in a loop keeps the monitor's latest hundred, never one row a call", async () => {
    const { location, storage: store } = await storage();
    const { token } = await heartbeatMonitor(store);
    for (let i = 0; i < 130; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: arrivals in order
      await receiveHeartbeat(store, token, undefined, t0 + i, {
        exitCode: 1,
        message: "again",
      });
    }
    const rows = await runSql(
      location,
      "SELECT min(arrived_at) AS oldest, count(*) AS n FROM heartbeats"
    );
    expect(Number(rows[0]?.n)).toBe(100);
    expect(Number(rows[0]?.oldest)).toBe(t0 + 30);
  });

  test("a heartbeat that says the job ran is bounded the same", async () => {
    const { location, storage: store } = await storage();
    const { token } = await heartbeatMonitor(store);
    for (let i = 0; i < 105; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: arrivals in order
      await receiveHeartbeat(store, token, undefined, t0 + i);
    }
    const [row] = await runSql(
      location,
      "SELECT count(*) AS n FROM heartbeats"
    );
    expect(Number(row?.n)).toBe(100);
  });
});

describe("the head of a body", () => {
  test("is cut to the bytes asked per chunk, so a first chunk larger than the limit is never kept whole", async () => {
    const head = await readBodyHead(
      call("", { body: new Uint8Array(100_000).fill(65), method: "POST" }),
      heartbeatBodyReadBytes
    );
    expect(head.length).toBe(heartbeatBodyReadBytes);
  });

  test("is whatever a short body holds, and nothing for a call with no body", async () => {
    expect(
      new TextDecoder().decode(
        await readBodyHead(call("", { body: "short", method: "POST" }), 1024)
      )
    ).toBe("short");
    expect((await readBodyHead(call(""), 1024)).length).toBe(0);
  });
});
