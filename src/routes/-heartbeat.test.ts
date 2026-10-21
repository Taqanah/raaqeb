import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clientAddressHeader } from "@/server/boot/proxies.ts";
import { runSql, scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import {
  type MonitorInput,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import { ingest } from "./-heartbeat.ts";

let open:
  | {
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
      storage: Storage;
    }
  | undefined;

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

const beat: MonitorInput = {
  channels: [],
  config: {
    schedule: { everyMs: 300_000, kind: "every" },
    type: "heartbeat",
  },
  events: [...monitorEventKinds],
  intervalMs: 60_000,
  name: "Backup",
  retries: 2,
  tags: [],
  timeoutMs: 10_000,
};

async function setup(): Promise<{
  location: DatabaseLocation;
  storage: Storage;
  token: string;
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
  const { id } = await opened.storage.monitors.create(beat);
  const token = await opened.storage.monitors.heartbeatTokenOf(id);
  if (token === undefined) {
    throw new Error("a heartbeat monitor without a token");
  }
  return { location: scratch.location, storage: opened.storage, token };
}

async function rows(location: DatabaseLocation) {
  return (
    await runSql(
      location,
      "SELECT failed, exit_code, message, source_ip FROM heartbeats ORDER BY arrived_at"
    )
  ).map((row) => [
    Number(row.failed),
    row.exit_code === null ? null : Number(row.exit_code),
    row.message,
    row.source_ip,
  ]);
}

const at = (token: string, query = "") =>
  `http://raaqeb.test/api/heartbeat/${token}${query}`;

describe("a call to a heartbeat URL, whichever route takes it", () => {
  test("a plain call is stored as the job having run, with the caller's address, and answers OK", async () => {
    const { location, storage, token } = await setup();
    const response = await ingest(
      storage,
      token,
      new Request(at(token), {
        headers: { [clientAddressHeader]: "203.0.113.7" },
      }),
      false
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(await rows(location)).toEqual([[0, null, null, "203.0.113.7"]]);
  });

  test("a call to the fail address is stored as a failure with its message, and still answers OK", async () => {
    const { location, storage, token } = await setup();
    const response = await ingest(
      storage,
      token,
      new Request(at(token, "?exit=2&message=disk%20full")),
      true
    );
    expect(response.status).toBe(200);
    expect(await rows(location)).toEqual([[1, 2, "disk full", null]]);
  });

  test("a POST to the fail address takes the message from its body", async () => {
    const { location, storage, token } = await setup();
    await ingest(
      storage,
      token,
      new Request(at(token), { body: "no space left\n", method: "POST" }),
      true
    );
    expect(await rows(location)).toEqual([[1, null, "no space left", null]]);
  });

  test("a HEAD to the fail address records the failure and gets no body", async () => {
    const { location, storage, token } = await setup();
    const response = await ingest(
      storage,
      token,
      new Request(at(token, "?status=fail"), { method: "HEAD" }),
      false
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(await rows(location)).toEqual([[1, null, null, null]]);
  });

  test("a status or an exit code it cannot read is a plain heartbeat, as any query was before", async () => {
    const { location, storage, token } = await setup();
    const response = await ingest(
      storage,
      token,
      new Request(at(token, "?exit=lots&status=success")),
      false
    );
    expect(response.status).toBe(200);
    expect(await rows(location)).toEqual([[0, null, null, null]]);
  });

  test("takes the arrival time before it reads the body, so a slow body does not move it", async () => {
    const { location, storage, token } = await setup();
    const clock = spyOn(Date, "now");
    clock.mockReturnValueOnce(1000).mockReturnValue(9000);
    try {
      await ingest(
        storage,
        token,
        new Request(at(token), { body: "slow", method: "POST" }),
        true
      );
    } finally {
      clock.mockRestore();
    }
    const [row] = await runSql(location, "SELECT arrived_at FROM heartbeats");
    expect(Number(row?.arrived_at)).toBe(1000);
  });

  test("an unknown token answers 404 to a failure as to anything else", async () => {
    const { location, storage } = await setup();
    const stranger = "A".repeat(22);
    const response = await ingest(
      storage,
      stranger,
      new Request(at(stranger), { body: "x", method: "POST" }),
      true
    );
    expect(response.status).toBe(404);
    expect(await rows(location)).toEqual([]);
  });

  test("no open database answers 503", async () => {
    const response = await ingest(
      undefined,
      "A".repeat(22),
      new Request(at("A".repeat(22))),
      true
    );
    expect(response.status).toBe(503);
  });
});
