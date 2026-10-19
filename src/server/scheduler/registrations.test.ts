import { describe, expect, spyOn, test } from "bun:test";
import type {
  RegistrationRead,
  RegistrationReader,
} from "@/server/checks/registration.ts";
import type { RegistrationsRepository } from "@/server/storage/registrations.ts";
import {
  type HttpConfig,
  type Monitor,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import type { DomainRegistration } from "@/shared/schemas/registration.ts";
import {
  createRegistrationPass,
  type RegistrationMonitor,
  registrationPeriodMs,
  registrationRetryIntervalMs,
} from "./registrations.ts";
import type { MonitorEvent } from "./schedule.ts";

const day = 86_400_000;
/** 2026-10-18T12:00:00Z. */
const now = Date.UTC(2026, 9, 18, 12);

const site: HttpConfig = {
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  type: "http",
  url: "https://status.raaqeb.dev/health",
};

const found: RegistrationRead = {
  domain: "raaqeb.dev",
  expiresAt: now + 300 * day,
};

const stored = (
  monitorId: string,
  more: Partial<DomainRegistration> = {}
): DomainRegistration => ({
  ...found,
  monitorId,
  readAt: now,
  warned: false,
  ...more,
});

type Answer =
  | RegistrationRead
  | undefined
  | Error
  | Promise<RegistrationRead | undefined>;

/** A fake reader: per call, the read to answer, nothing for a failed one, an error to throw or a read to wait on; the hosts asked. */
function reader(answers: Answer[]) {
  const hosts: string[] = [];
  const read: RegistrationReader = {
    read: (host) => {
      hosts.push(host);
      if (answers.length === 0) {
        throw new Error("the fake reader ran out of answers");
      }
      const answer = answers.shift();
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
  return { hosts, read };
}

/** An in-memory registrations repository; `lists` counts the passes that read it. */
function stores(records: DomainRegistration[] = []) {
  const rows = new Map(records.map((r) => [r.monitorId, r]));
  const asked = { lists: 0 };
  const registrations: RegistrationsRepository = {
    find: (id) => Promise.resolve(rows.get(id)),
    list: () => {
      asked.lists += 1;
      return Promise.resolve([...rows.values()]);
    },
    remove: (id) => {
      rows.delete(id);
      return Promise.resolve();
    },
    replace: (r) => {
      // The warning already sent stays while the expiry date is the same, as the repository keeps it.
      const kept = rows.get(r.monitorId);
      rows.set(r.monitorId, {
        ...r,
        warned:
          kept?.warned === true &&
          r.expiresAt !== undefined &&
          kept.expiresAt === r.expiresAt,
      });
      return Promise.resolve();
    },
    warned: (id, expiresAt) => {
      const row = rows.get(id);
      if (row?.expiresAt !== expiresAt) {
        return Promise.resolve(false);
      }
      rows.set(id, { ...row, warned: true });
      return Promise.resolve(true);
    },
  };
  return { asked, registrations, rows };
}

const monitorOf = (
  id: string,
  config: Monitor["config"] = site,
  more: Partial<RegistrationMonitor> = {}
): RegistrationMonitor => ({
  channels: ["c1"],
  config,
  events: [...monitorEventKinds],
  id,
  paused: false,
  ...more,
});

const running = { isStopped: () => false };

/** A pass may start every millisecond, so a test can look again at once. */
const everyPass = { ...running, periodMs: 1 };

describe("the registration pass over the monitors", () => {
  test("reads every due HTTP, TCP and DNS monitor and stores what it read; one read earlier today is left alone", async () => {
    const today = stored("m4", { readAt: Date.UTC(2026, 9, 18) });
    const { registrations, rows } = stores([today]);
    const { hosts, read } = reader([found, found, found]);
    const pass = createRegistrationPass({ registrations }, read, running);
    pass.run(now, [
      monitorOf("m1"),
      monitorOf("m2", { host: "db.raaqeb.dev", port: 5432, type: "tcp" }),
      monitorOf("m3", { name: "raaqeb.dev", recordType: "MX", type: "dns" }),
      monitorOf("m4"),
    ]);
    await pass.idle();
    expect(hosts).toEqual(["status.raaqeb.dev", "db.raaqeb.dev", "raaqeb.dev"]);
    expect(rows.get("m1")).toEqual(stored("m1"));
    expect(rows.get("m2")).toEqual(stored("m2"));
    expect(rows.get("m3")).toEqual(stored("m3"));
    expect(rows.get("m4")).toEqual(today);
  });

  test("a registration read on an earlier UTC day is read again, and an unknown one is stored as unknown", async () => {
    const yesterday = stored("m1", { readAt: Date.UTC(2026, 9, 17, 23) });
    const { registrations, rows } = stores([yesterday]);
    const { read } = reader([{ domain: undefined, expiresAt: undefined }]);
    const pass = createRegistrationPass({ registrations }, read, running);
    pass.run(now, [monitorOf("m1")]);
    await pass.idle();
    expect(rows.get("m1")).toEqual(
      stored("m1", { domain: undefined, expiresAt: undefined })
    );
  });

  test("a failed read leaves the registration as it was and the pass goes on to the next monitor", async () => {
    const old = stored("m1", { readAt: now - day });
    const { registrations, rows } = stores([old]);
    const { read } = reader([undefined, found]);
    const pass = createRegistrationPass({ registrations }, read, running);
    pass.run(now, [monitorOf("m1"), monitorOf("m2")]);
    await pass.idle();
    expect(rows.get("m1")).toEqual(old);
    expect(rows.get("m2")).toEqual(stored("m2"));
  });

  test("a write that fails, as for a monitor deleted since the tick read it, skips that monitor and the pass goes on to the next and its warnings", async () => {
    const { registrations, rows } = stores();
    const raised: string[] = [];
    const { read } = reader([
      found,
      { domain: "raaqeb.dev", expiresAt: now + 10 * day },
    ]);
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const pass = createRegistrationPass(
        {
          registrations: {
            ...registrations,
            replace: (r) =>
              r.monitorId === "gone"
                ? Promise.reject(new Error("FOREIGN KEY constraint failed"))
                : registrations.replace(r),
          },
        },
        read,
        {
          ...running,
          onExpiring: (event) => {
            raised.push(event.monitorId);
            return Promise.resolve();
          },
        }
      );
      pass.run(now, [monitorOf("gone"), monitorOf("m2")]);
      await pass.idle();
      expect(rows.has("gone")).toBe(false);
      expect(rows.get("m2")?.warned).toBe(true);
      expect(raised).toEqual(["m2"]);
      expect(String(errors.mock.calls[0]?.[0])).toContain(
        "the registration of the monitor gone could not be stored: FOREIGN KEY constraint failed"
      );
    } finally {
      errors.mockRestore();
    }
  });

  test("a read that throws is a failed read", async () => {
    const { registrations, rows } = stores();
    const { read } = reader([new Error("the registry spoke nonsense"), found]);
    const pass = createRegistrationPass({ registrations }, read, running);
    pass.run(now, [monitorOf("m1"), monitorOf("m2")]);
    await pass.idle();
    expect(rows.has("m1")).toBe(false);
    expect(rows.get("m2")).toEqual(stored("m2"));
  });

  test("a failed read is tried again after the retry interval, not on the next pass", async () => {
    const { registrations, rows } = stores();
    const { hosts, read } = reader([undefined, found]);
    const pass = createRegistrationPass({ registrations }, read, everyPass);
    const monitors = [monitorOf("m1")];
    pass.run(now, monitors);
    await pass.idle();
    pass.run(now + registrationRetryIntervalMs - 1, monitors);
    await pass.idle();
    expect(hosts).toHaveLength(1);
    const later = now + registrationRetryIntervalMs;
    pass.run(later, monitors);
    await pass.idle();
    expect(hosts).toHaveLength(2);
    expect(rows.get("m1")).toEqual(stored("m1", { readAt: later }));
  });

  test("a paused monitor, one with the option off, an IP address and another check type are not read", async () => {
    const { registrations, rows } = stores();
    const { hosts, read } = reader([]);
    const pass = createRegistrationPass({ registrations }, read, running);
    pass.run(now, [
      monitorOf("m1", site, { paused: true }),
      monitorOf("m2", { ...site, domainExpiry: false }),
      monitorOf("m3", { ...site, url: "http://192.0.2.10/" }),
      monitorOf("m4", {
        schedule: { everyMs: 60_000, kind: "every" },
        type: "heartbeat",
      }),
    ]);
    await pass.idle();
    expect(hosts).toEqual([]);
    expect(rows.size).toBe(0);
  });
});

describe("the registration pass's cadence", () => {
  test("a pass starts at most once a period", async () => {
    const { asked, registrations } = stores();
    const { read } = reader([]);
    const pass = createRegistrationPass({ registrations }, read, running);
    pass.run(now, []);
    await pass.idle();
    pass.run(now + registrationPeriodMs - 1, []);
    await pass.idle();
    expect(asked.lists).toBe(1);
    pass.run(now + registrationPeriodMs, []);
    await pass.idle();
    expect(asked.lists).toBe(2);
  });

  test("a pass never runs twice at once, and waiting for the pass lasts until the one under way ends", async () => {
    const { registrations, rows } = stores();
    const slow = Promise.withResolvers<RegistrationRead | undefined>();
    const { hosts, read } = reader([slow.promise]);
    const pass = createRegistrationPass({ registrations }, read, running);
    const monitors = [monitorOf("m1")];
    pass.run(now, monitors);
    await Bun.sleep(0);
    pass.run(now + registrationPeriodMs, monitors);
    let idle = false;
    const waiting = pass.idle().then(() => {
      idle = true;
    });
    await Bun.sleep(0);
    expect(idle).toBe(false);
    slow.resolve(found);
    await waiting;
    expect(hosts).toHaveLength(1);
    expect(rows.get("m1")).toEqual(stored("m1"));
  });

  test("a pass that fails is logged, and the next period's pass runs", async () => {
    const { registrations, rows } = stores();
    const { list } = registrations;
    let failing = true;
    const { read } = reader([found]);
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const pass = createRegistrationPass(
        {
          registrations: {
            ...registrations,
            list: () => {
              if (failing) {
                failing = false;
                return Promise.reject(new Error("the disk is busy"));
              }
              return list();
            },
          },
        },
        read,
        running
      );
      const monitors = [monitorOf("m1")];
      pass.run(now, monitors);
      await pass.idle();
      expect(String(errors.mock.calls[0]?.[0])).toContain(
        "the registration pass failed: the disk is busy"
      );
      pass.run(now + registrationPeriodMs, monitors);
      await pass.idle();
      expect(rows.get("m1")).toEqual(
        stored("m1", { readAt: now + registrationPeriodMs })
      );
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the registration pass once the scheduler stops", () => {
  test("a read that ends after stop writes nothing, and the pass ends before the next monitor", async () => {
    const { registrations, rows } = stores();
    const slow = Promise.withResolvers<RegistrationRead | undefined>();
    const { hosts, read } = reader([slow.promise, found]);
    let stopped = false;
    const pass = createRegistrationPass({ registrations }, read, {
      isStopped: () => stopped,
    });
    pass.run(now, [monitorOf("m1"), monitorOf("m2")]);
    await Bun.sleep(0);
    stopped = true;
    slow.resolve(found);
    await pass.idle();
    expect(rows.size).toBe(0);
    expect(hosts).toHaveLength(1);
  });

  test("stopping waits for a write under way and never for a read still out", async () => {
    const { registrations, rows } = stores();
    const write = Promise.withResolvers<undefined>();
    const writing = Promise.withResolvers<undefined>();
    const hung = Promise.withResolvers<RegistrationRead | undefined>();
    const { read } = reader([found, hung.promise]);
    let stopped = false;
    const pass = createRegistrationPass(
      {
        registrations: {
          ...registrations,
          replace: async (r) => {
            writing.resolve(undefined);
            await write.promise;
            await registrations.replace(r);
          },
        },
      },
      read,
      { isStopped: () => stopped }
    );
    pass.run(now, [monitorOf("m1"), monitorOf("m2")]);
    await writing.promise;
    stopped = true;
    let flushed = false;
    const flushing = pass.flush().then(() => {
      flushed = true;
    });
    await Bun.sleep(0);
    expect(flushed).toBe(false);
    write.resolve(undefined);
    await flushing;
    expect(rows.has("m1")).toBe(true);
    expect(rows.has("m2")).toBe(false);
  });
});

describe("the domain expiring warnings the pass raises", () => {
  type Expiring = Extract<MonitorEvent, { kind: "domain_expiring" }>;

  /** A pass over stored registrations that records every warning it raises. */
  function warning(
    records: DomainRegistration[],
    onExpiring?: (event: Expiring) => Promise<void>,
    covers?: (monitorId: string) => boolean
  ) {
    const kept = stores(records);
    const raised: Expiring[] = [];
    const pass = createRegistrationPass(
      { registrations: kept.registrations },
      reader([]).read,
      {
        ...everyPass,
        covers,
        onExpiring:
          onExpiring ??
          ((event) => {
            raised.push(event);
            return Promise.resolve();
          }),
      }
    );
    return { ...kept, pass, raised };
  }

  const soon = stored("m1", { expiresAt: now + 10 * day });

  test("a registration expiring within 30 days raises the warning once, and the record remembers it", async () => {
    const w = warning([soon]);
    w.pass.run(now, [monitorOf("m1")]);
    await w.pass.idle();
    w.pass.run(now + 1, [monitorOf("m1")]);
    await w.pass.idle();
    expect(w.raised).toEqual([
      {
        at: now,
        domain: "raaqeb.dev",
        expiresAt: now + 10 * day,
        kind: "domain_expiring",
        monitorId: "m1",
      },
    ]);
    expect(w.rows.get("m1")?.warned).toBe(true);
  });

  test("a registration read in this pass is judged in this pass", async () => {
    const { registrations, rows } = stores();
    const raised: Expiring[] = [];
    const { read } = reader([{ domain: "raaqeb.dev", expiresAt: now + day }]);
    const pass = createRegistrationPass({ registrations }, read, {
      ...running,
      onExpiring: (event) => {
        raised.push(event);
        return Promise.resolve();
      },
    });
    pass.run(now, [monitorOf("m1")]);
    await pass.idle();
    expect(raised).toHaveLength(1);
    expect(rows.get("m1")?.warned).toBe(true);
  });

  test("a registration with more than 30 days left, or an unknown date, raises nothing", async () => {
    const w = warning([
      stored("m1", { expiresAt: now + 31 * day }),
      stored("m2", { domain: undefined, expiresAt: undefined }),
    ]);
    w.pass.run(now, [monitorOf("m1"), monitorOf("m2")]);
    await w.pass.idle();
    expect(w.raised).toEqual([]);
  });

  test("a paused monitor, or one with the option off, raises no warning", async () => {
    const w = warning([soon, { ...soon, monitorId: "m2" }]);
    w.pass.run(now, [
      monitorOf("m1", site, { paused: true }),
      monitorOf("m2", { ...site, domainExpiry: false }),
    ]);
    await w.pass.idle();
    expect(w.raised).toEqual([]);
  });

  test("a warning whose notification could not be queued is not remembered, so the next pass raises it again", async () => {
    let refuse = true;
    const raised: Expiring[] = [];
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const w = warning([soon], (event) => {
        raised.push(event);
        if (refuse) {
          refuse = false;
          return Promise.reject(new Error("the queue is busy"));
        }
        return Promise.resolve();
      });
      w.pass.run(now, [monitorOf("m1")]);
      await w.pass.idle();
      expect(w.rows.get("m1")?.warned).toBe(false);
      w.pass.run(now + 1, [monitorOf("m1")]);
      await w.pass.idle();
      expect(raised).toHaveLength(2);
      expect(w.rows.get("m1")?.warned).toBe(true);
      expect(String(errors.mock.calls[0]?.[0])).toContain(
        "the domain expiring warning of the monitor m1 is raised again at the next pass"
      );
    } finally {
      errors.mockRestore();
    }
  });

  test("a monitor with domain expiring switched off raises no warning and remembers none, so switching it on later sends it", async () => {
    const w = warning([soon]);
    w.pass.run(now, [monitorOf("m1", site, { events: ["down"] })]);
    await w.pass.idle();
    expect(w.raised).toEqual([]);
    expect(w.rows.get("m1")?.warned).toBe(false);
    w.pass.run(now + 1, [monitorOf("m1")]);
    await w.pass.idle();
    expect(w.raised).toHaveLength(1);
  });

  test("a monitor with no channel raises no warning and remembers none, so selecting a channel later sends it", async () => {
    const w = warning([soon]);
    w.pass.run(now, [monitorOf("m1", site, { channels: [] })]);
    await w.pass.idle();
    expect(w.raised).toEqual([]);
    expect(w.rows.get("m1")?.warned).toBe(false);
    w.pass.run(now + 1, [monitorOf("m1")]);
    await w.pass.idle();
    expect(w.raised).toHaveLength(1);
  });

  test("a monitor a window covers raises no warning and remembers none, so the warning goes once the window ends", async () => {
    let covered = true;
    const w = warning([soon], undefined, () => covered);
    w.pass.run(now, [monitorOf("m1")]);
    await w.pass.idle();
    expect(w.raised).toEqual([]);
    covered = false;
    w.pass.run(now + 1, [monitorOf("m1")]);
    await w.pass.idle();
    expect(w.raised).toHaveLength(1);
  });

  test("once the scheduler stops, the pass raises nothing more", async () => {
    const raised: Expiring[] = [];
    let stopped = false;
    const kept = stores([soon]);
    const pass = createRegistrationPass(
      { registrations: kept.registrations },
      reader([]).read,
      {
        isStopped: () => stopped,
        onExpiring: (event) => {
          raised.push(event);
          return Promise.resolve();
        },
      }
    );
    stopped = true;
    pass.run(now, [monitorOf("m1")]);
    await pass.idle();
    expect(raised).toEqual([]);
  });
});
