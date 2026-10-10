import { afterEach, describe, expect, test } from "bun:test";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import { heartbeatResponse, receiveHeartbeat } from "./heartbeat.ts";

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
