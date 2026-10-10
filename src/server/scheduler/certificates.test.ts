import { describe, expect, spyOn, test } from "bun:test";
import {
  certificateReadIntervalMs,
  type PeerCertificate,
  type TlsIo,
  type TlsTarget,
} from "@/server/checks/certificate.ts";
import type { CertificatesRepository } from "@/server/storage/certificates.ts";
import type { CertificateRecord } from "@/shared/schemas/certificate.ts";
import {
  type HttpConfig,
  type Monitor,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import {
  type CertificateMonitor,
  certificatePeriodMs,
  certificateRetryIntervalMs,
  createCertificatePass,
} from "./certificates.ts";
import type { MonitorEvent } from "./schedule.ts";

const now = 1_700_000_000_000;

const https: HttpConfig = {
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  tlsExpiryDays: 14,
  type: "http",
  url: "https://example.test/health",
};

const peer: PeerCertificate = {
  fingerprint256:
    "61:53:A9:6F:D1:A6:AB:7F:4D:43:8F:C3:49:32:48:42:99:D0:72:9D:91:40:B3:A1:26:BB:2F:9C:07:B0:22:00",
  issuer: {
    C: "US",
    O: "SSL Corporation",
    CN: "Cloudflare TLS Issuing ECC CA 3",
  },
  subject: { CN: "example.test" },
  subjectaltname: "DNS:example.test, DNS:*.example.test, IP Address:192.0.2.1",
  valid_from: "Jul 29 22:10:08 2026 GMT",
  valid_to: "Oct 27 22:17:21 2026 GMT",
};

const record: CertificateRecord = {
  fingerprint: peer.fingerprint256,
  issuer: "C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3",
  lastSeenAt: now,
  monitorId: "m1",
  names: ["example.test", "*.example.test", "192.0.2.1"],
  subject: "CN=example.test",
  validFrom: Date.UTC(2026, 6, 29, 22, 10, 8),
  validTo: Date.UTC(2026, 9, 27, 22, 17, 21),
};

type Answer = PeerCertificate | Error | Promise<PeerCertificate>;

/** A fake TLS read on a clock the test moves: the peer to answer, an error to throw or a read to wait on, per call; the targets asked. */
function tlsIo(answers: Answer[]) {
  const targets: TlsTarget[] = [];
  let clock = now;
  const io: TlsIo = {
    now: () => clock,
    readTls: (target) => {
      targets.push(target);
      const answer = answers.shift();
      if (!answer) {
        throw new Error("the fake TLS read ran out of answers");
      }
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
  return {
    io,
    /** Moves the clock to `at` and answers it. */
    at: (at: number) => {
      clock = at;
      return at;
    },
    targets,
  };
}

/** An in-memory certificates repository; `lists` counts the passes that read it. */
function stores(records: CertificateRecord[] = []) {
  const rows = new Map(records.map((r) => [r.monitorId, r]));
  const asked = { lists: 0 };
  const certificates: CertificatesRepository = {
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
      // The warning already sent stays while the fingerprint is the same, as the repository keeps it.
      const kept = rows.get(r.monitorId);
      rows.set(
        r.monitorId,
        kept?.fingerprint === r.fingerprint && kept.warned
          ? { ...r, warned: kept.warned }
          : r
      );
      return Promise.resolve();
    },
    warned: (id, fingerprint, warning) => {
      const row = rows.get(id);
      if (row?.fingerprint !== fingerprint) {
        return Promise.resolve(false);
      }
      rows.set(id, { ...row, warned: warning });
      return Promise.resolve(true);
    },
  };
  return { asked, certificates, rows };
}

const monitorOf = (
  id: string,
  config: HttpConfig | Monitor["config"],
  paused = false,
  events: Monitor["events"] = [...monitorEventKinds],
  channels: Monitor["channels"] = ["c1"]
): CertificateMonitor => ({
  channels,
  config,
  events,
  id,
  paused,
});

const running = { isStopped: () => false };

/** A pass may start every millisecond, so a test can look one millisecond before the retry interval ends. */
const everyPass = { ...running, periodMs: 1 };

describe("the certificate reader's pass over the monitors", () => {
  test("reads every due HTTPS monitor with the option on and stores the record; a monitor read within the interval is left alone", async () => {
    const fresh = { ...record, monitorId: "m2", lastSeenAt: now - 1000 };
    const { certificates, rows } = stores([fresh]);
    const { io, targets } = tlsIo([peer]);
    const pass = createCertificatePass({ certificates }, io, running);
    pass.run(now, [monitorOf("m1", https), monitorOf("m2", https)]);
    await pass.idle();
    expect(targets).toHaveLength(1);
    expect(rows.get("m1")).toEqual(record);
    expect(rows.get("m2")).toEqual(fresh);
  });

  test("a record seen the interval ago is read again: a new fingerprint replaces it, the same one refreshes last seen", async () => {
    const old = { ...record, lastSeenAt: now - certificateReadIntervalMs };
    const renewed: PeerCertificate = {
      ...peer,
      fingerprint256: "AA:BB",
      valid_to: "Jan 25 22:17:21 2027 GMT",
    };
    const { certificates, rows } = stores([old]);
    const { at, io } = tlsIo([renewed, renewed]);
    const pass = createCertificatePass({ certificates }, io, running);
    const monitors = [monitorOf("m1", https)];
    pass.run(now, monitors);
    await pass.idle();
    expect(rows.get("m1")).toEqual({
      ...record,
      fingerprint: "AA:BB",
      lastSeenAt: now,
      validTo: Date.UTC(2027, 0, 25, 22, 17, 21),
    });
    const later = at(now + certificateReadIntervalMs);
    pass.run(later, monitors);
    await pass.idle();
    expect(rows.get("m1")).toMatchObject({
      fingerprint: "AA:BB",
      lastSeenAt: later,
    });
  });

  test("a failed read leaves the record as it was and the pass goes on to the next monitor", async () => {
    const old = { ...record, lastSeenAt: now - certificateReadIntervalMs };
    const { certificates, rows } = stores([old]);
    const { io } = tlsIo([new Error("Failed to connect"), peer]);
    const pass = createCertificatePass({ certificates }, io, running);
    pass.run(now, [monitorOf("m1", https), monitorOf("m2", https)]);
    await pass.idle();
    expect(rows.get("m1")).toEqual(old);
    expect(rows.get("m2")).toEqual({ ...record, monitorId: "m2" });
  });

  test("a failed read is tried again after the retry interval, not on the next pass", async () => {
    const { certificates, rows } = stores();
    const failing = () => new Error("Failed to connect");
    const { at, io, targets } = tlsIo([failing(), peer]);
    const pass = createCertificatePass({ certificates }, io, everyPass);
    const monitors = [monitorOf("m1", https)];
    pass.run(now, monitors);
    await pass.idle();
    expect(targets).toHaveLength(1);
    pass.run(at(now + certificateRetryIntervalMs - 1), monitors);
    await pass.idle();
    expect(targets).toHaveLength(1);
    const later = at(now + certificateRetryIntervalMs);
    pass.run(later, monitors);
    await pass.idle();
    expect(targets).toHaveLength(2);
    expect(rows.get("m1")).toEqual({ ...record, lastSeenAt: later });
  });

  test("a later failed read is tried again an hour after it, not an hour after the first", async () => {
    const { certificates } = stores();
    const failing = () => new Error("Failed to connect");
    const { at, io, targets } = tlsIo([failing(), peer, failing(), peer]);
    const pass = createCertificatePass({ certificates }, io, everyPass);
    const monitors = [monitorOf("m1", https)];
    pass.run(now, monitors);
    await pass.idle();
    const read = at(now + certificateRetryIntervalMs);
    pass.run(read, monitors);
    await pass.idle();
    // Due again 12 hours after the read that succeeded; this one fails.
    const failed = at(read + certificateReadIntervalMs);
    pass.run(failed, monitors);
    await pass.idle();
    expect(targets).toHaveLength(3);
    pass.run(at(failed + certificateRetryIntervalMs - 1), monitors);
    await pass.idle();
    expect(targets).toHaveLength(3);
    pass.run(at(failed + certificateRetryIntervalMs), monitors);
    await pass.idle();
    expect(targets).toHaveLength(4);
  });

  test("the retry interval is shorter than the read interval", () => {
    expect(certificateRetryIntervalMs).toBeLessThan(certificateReadIntervalMs);
  });

  test("a paused monitor, a plain HTTP monitor, one with the option off and another check type are not read", async () => {
    const { certificates, rows } = stores();
    const { io, targets } = tlsIo([]);
    const pass = createCertificatePass({ certificates }, io, running);
    pass.run(now, [
      monitorOf("m1", https, true),
      monitorOf("m2", { ...https, url: "http://example.test/" }),
      monitorOf("m3", { ...https, tlsExpiryDays: undefined }),
      monitorOf("m4", { host: "example.test", port: 443, type: "tcp" }),
    ]);
    await pass.idle();
    expect(targets).toEqual([]);
    expect(rows.size).toBe(0);
  });

  test("a monitor whose expiry option is switched on is read at the next pass, not held back as a failed read", async () => {
    const { certificates, rows } = stores();
    const { at, io, targets } = tlsIo([peer]);
    const pass = createCertificatePass({ certificates }, io, running);
    pass.run(now, [monitorOf("m1", { ...https, tlsExpiryDays: undefined })]);
    await pass.idle();
    const next = at(now + certificatePeriodMs);
    pass.run(next, [monitorOf("m1", https)]);
    await pass.idle();
    expect(targets).toHaveLength(1);
    expect(rows.get("m1")).toEqual({ ...record, lastSeenAt: next });
  });
});

describe("the certificate pass's cadence", () => {
  test("a pass starts at most once a period", async () => {
    const { asked, certificates } = stores();
    const { io } = tlsIo([]);
    const pass = createCertificatePass({ certificates }, io, running);
    pass.run(now, []);
    await pass.idle();
    pass.run(now + certificatePeriodMs - 1, []);
    await pass.idle();
    expect(asked.lists).toBe(1);
    pass.run(now + certificatePeriodMs, []);
    await pass.idle();
    expect(asked.lists).toBe(2);
  });

  test("the period is the one the scheduler hands in", async () => {
    const { asked, certificates } = stores();
    const { io } = tlsIo([]);
    const pass = createCertificatePass({ certificates }, io, {
      ...running,
      periodMs: 10,
    });
    pass.run(now, []);
    await pass.idle();
    pass.run(now + 10, []);
    await pass.idle();
    expect(asked.lists).toBe(2);
  });

  test("a pass never runs twice at once, and waiting for the pass lasts until the one under way ends", async () => {
    const { certificates, rows } = stores();
    const read = Promise.withResolvers<PeerCertificate>();
    const { io, targets } = tlsIo([read.promise]);
    const pass = createCertificatePass({ certificates }, io, running);
    const monitors = [monitorOf("m1", https)];
    pass.run(now, monitors);
    await Bun.sleep(0);
    pass.run(now + certificatePeriodMs, monitors);
    let idle = false;
    const waiting = pass.idle().then(() => {
      idle = true;
    });
    await Bun.sleep(0);
    expect(idle).toBe(false);
    read.resolve(peer);
    await waiting;
    expect(targets).toHaveLength(1);
    expect(rows.get("m1")).toMatchObject({ monitorId: "m1" });
  });

  test("a period that passes while a pass is under way is not lost: the next pass starts as soon as that one ends", async () => {
    const { asked, certificates } = stores();
    const read = Promise.withResolvers<PeerCertificate>();
    const { io } = tlsIo([read.promise]);
    const pass = createCertificatePass({ certificates }, io, running);
    const monitors = [monitorOf("m1", https)];
    pass.run(now, monitors);
    await Bun.sleep(0);
    // Skipped: the first pass is still reading.
    pass.run(now + certificatePeriodMs, monitors);
    read.resolve(peer);
    await pass.idle();
    pass.run(now + certificatePeriodMs + 1, []);
    await pass.idle();
    expect(asked.lists).toBe(2);
  });

  test("a pass that fails is logged, and the next period's pass runs", async () => {
    const { certificates, rows } = stores();
    const { list } = certificates;
    let failing = true;
    const { io } = tlsIo([peer]);
    const errors = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      const pass = createCertificatePass(
        {
          certificates: {
            ...certificates,
            list: () => {
              if (failing) {
                failing = false;
                return Promise.reject(new Error("the disk is busy"));
              }
              return list();
            },
          },
        },
        io,
        running
      );
      const monitors = [monitorOf("m1", https)];
      pass.run(now, monitors);
      await pass.idle();
      expect(String(errors.mock.calls[0]?.[0])).toContain(
        "the certificate pass failed: the disk is busy"
      );
      pass.run(now + certificatePeriodMs, monitors);
      await pass.idle();
      expect(rows.get("m1")).toMatchObject({ monitorId: "m1" });
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the certificate pass once the scheduler stops", () => {
  test("a read that ends after stop writes no record, and the pass ends before the next monitor", async () => {
    const { certificates, rows } = stores();
    const read = Promise.withResolvers<PeerCertificate>();
    const { io, targets } = tlsIo([read.promise, peer]);
    let stopped = false;
    const pass = createCertificatePass({ certificates }, io, {
      isStopped: () => stopped,
    });
    pass.run(now, [monitorOf("m1", https), monitorOf("m2", https)]);
    await Bun.sleep(0);
    stopped = true;
    read.resolve(peer);
    await pass.idle();
    expect(rows.size).toBe(0);
    expect(targets).toHaveLength(1);
  });

  test("a read that fails after stop does not lead on to the next monitor", async () => {
    const { certificates } = stores();
    const read = Promise.withResolvers<PeerCertificate>();
    const { io, targets } = tlsIo([read.promise, peer]);
    let stopped = false;
    const pass = createCertificatePass({ certificates }, io, {
      isStopped: () => stopped,
    });
    pass.run(now, [monitorOf("m1", https), monitorOf("m2", https)]);
    await Bun.sleep(0);
    stopped = true;
    read.reject(new Error("Failed to connect"));
    await pass.idle();
    expect(targets).toHaveLength(1);
  });

  test("stopping waits for a write under way", async () => {
    const { certificates, rows } = stores();
    const write = Promise.withResolvers<undefined>();
    const hung = Promise.withResolvers<PeerCertificate>();
    const { io } = tlsIo([peer, hung.promise]);
    let stopped = false;
    const writing = Promise.withResolvers<undefined>();
    const pass = createCertificatePass(
      {
        certificates: {
          ...certificates,
          replace: async (r) => {
            writing.resolve(undefined);
            await write.promise;
            await certificates.replace(r);
          },
        },
      },
      io,
      { isStopped: () => stopped }
    );
    pass.run(now, [monitorOf("m1", https), monitorOf("m2", https)]);
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
    // The pass stopped before the next monitor, so no read hangs past the flush.
    expect(rows.has("m2")).toBe(false);
  });

  test("stopping never waits for a read still out", async () => {
    const { certificates } = stores();
    const hung = Promise.withResolvers<PeerCertificate>();
    const { io } = tlsIo([hung.promise]);
    const pass = createCertificatePass({ certificates }, io, running);
    pass.run(now, [monitorOf("m1", https)]);
    await Bun.sleep(0);
    await pass.flush();
    hung.resolve(peer);
    await pass.idle();
  });
});

describe("the certificate warnings the pass raises", () => {
  const day = 86_400_000;
  type Expiring = Extract<MonitorEvent, { kind: "certificate_expiring" }>;

  /** A pass that records every warning it raises. */
  function warning(
    records: CertificateRecord[],
    answers: Answer[] = [],
    onExpiring?: (event: Expiring) => Promise<void>
  ) {
    const stored = stores(records);
    const tls = tlsIo(answers);
    const raised: Expiring[] = [];
    const pass = createCertificatePass(
      { certificates: stored.certificates },
      tls.io,
      {
        ...everyPass,
        onExpiring:
          onExpiring ??
          ((event) => {
            raised.push(event);
            return Promise.resolve();
          }),
      }
    );
    return { ...stored, ...tls, pass, raised };
  }

  const soon = { ...record, validTo: now + 10 * day };

  test("a certificate within the monitor's threshold raises the threshold's warning once, and the record remembers it", async () => {
    const w = warning([soon]);
    const monitors = [monitorOf("m1", https)];
    w.pass.run(now, monitors);
    await w.pass.idle();
    expect(w.raised).toEqual([
      {
        at: now,
        kind: "certificate_expiring",
        monitorId: "m1",
        validTo: now + 10 * day,
        warning: "threshold",
      },
    ]);
    expect(w.rows.get("m1")?.warned).toBe("threshold");
    w.pass.run(w.at(now + day), monitors);
    await w.pass.idle();
    expect(w.raised).toHaveLength(1);
  });

  test("the last day's warning follows once a day or less is left", async () => {
    const w = warning([{ ...soon, warned: "threshold" }]);
    const monitors = [monitorOf("m1", https)];
    const lastDay = w.at(now + 9 * day);
    w.pass.run(lastDay, monitors);
    await w.pass.idle();
    expect(w.raised.map((event) => [event.warning, event.at])).toEqual([
      ["last_day", lastDay],
    ]);
    expect(w.rows.get("m1")?.warned).toBe("last_day");
  });

  test("a certificate read in this pass is judged in this pass", async () => {
    const close: PeerCertificate = {
      ...peer,
      valid_to: "Nov 17 22:13:20 2023 GMT",
    };
    const w = warning([], [close]);
    w.pass.run(now, [monitorOf("m1", https)]);
    await w.pass.idle();
    expect(w.raised.map((event) => event.warning)).toEqual(["threshold"]);
    expect(w.rows.get("m1")?.warned).toBe("threshold");
  });

  test("a paused monitor, or one with the option off, raises no warning", async () => {
    const w = warning([soon, { ...soon, monitorId: "m2" }]);
    const off: HttpConfig = { ...https, tlsExpiryDays: undefined };
    w.pass.run(now, [monitorOf("m1", https, true), monitorOf("m2", off)]);
    await w.pass.idle();
    expect(w.raised).toEqual([]);
  });

  test("a warning whose notification could not be queued is not remembered, so the next pass raises it again", async () => {
    let fail = true;
    const raised: Expiring[] = [];
    const w = warning([soon], [], (event) => {
      if (fail) {
        return Promise.reject(new Error("the database did not answer"));
      }
      raised.push(event);
      return Promise.resolve();
    });
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    try {
      w.pass.run(now, [monitorOf("m1", https)]);
      await w.pass.idle();
      expect(w.rows.get("m1")).toEqual(soon);
      fail = false;
      w.pass.run(w.at(now + 1), [monitorOf("m1", https)]);
      await w.pass.idle();
      expect(raised.map((event) => event.warning)).toEqual(["threshold"]);
      expect(w.rows.get("m1")?.warned).toBe("threshold");
    } finally {
      stderr.mockRestore();
    }
  });

  test("once the scheduler stops, the pass raises nothing more", async () => {
    const w = warning([soon]);
    const pass = createCertificatePass({ certificates: w.certificates }, w.io, {
      isStopped: () => true,
      onExpiring: (event) => {
        w.raised.push(event);
        return Promise.resolve();
      },
      periodMs: 1,
    });
    pass.run(now, [monitorOf("m1", https)]);
    await pass.idle();
    expect(w.raised).toEqual([]);
  });
});

describe("edges of the certificate warnings", () => {
  const day = 86_400_000;
  const soon = { ...record, validTo: now + 10 * day };

  test("a certificate read again after its warning, with the same fingerprint, raises it no more", async () => {
    const warned = {
      ...soon,
      lastSeenAt: now - certificateReadIntervalMs,
      warned: "threshold" as const,
    };
    const stored = stores([warned]);
    const same: PeerCertificate = {
      ...peer,
      // Ten days after `now`, in OpenSSL's text.
      valid_to: "Nov 24 22:13:20 2023 GMT",
    };
    const { io, targets } = tlsIo([same]);
    const raised: MonitorEvent[] = [];
    const pass = createCertificatePass(
      { certificates: stored.certificates },
      io,
      {
        ...everyPass,
        onExpiring: (event) => {
          raised.push(event);
          return Promise.resolve();
        },
      }
    );
    pass.run(now, [monitorOf("m1", https)]);
    await pass.idle();
    expect(targets).toHaveLength(1);
    expect(stored.rows.get("m1")).toMatchObject({
      lastSeenAt: now,
      warned: "threshold",
    });
    expect(raised).toEqual([]);
  });

  test("a warning raised as the scheduler stops is not remembered, so the next boot raises it again", async () => {
    let stopped = false;
    const stored = stores([soon]);
    const { io } = tlsIo([]);
    const pass = createCertificatePass(
      { certificates: stored.certificates },
      io,
      {
        isStopped: () => stopped,
        onExpiring: () => {
          stopped = true;
          return Promise.resolve();
        },
        periodMs: 1,
      }
    );
    pass.run(now, [monitorOf("m1", https)]);
    await pass.idle();
    expect(stored.rows.get("m1")).toEqual(soon);
  });
});

describe("a certificate warning switched off", () => {
  const day = 86_400_000;
  const soon = { ...record, validTo: now + 10 * day };

  test("a monitor with certificate expiring switched off raises no warning and remembers none, so switching it on later sends the threshold's", async () => {
    const stored = stores([soon]);
    const { at, io } = tlsIo([]);
    const raised: Extract<MonitorEvent, { kind: "certificate_expiring" }>[] =
      [];
    const pass = createCertificatePass(
      { certificates: stored.certificates },
      io,
      {
        ...everyPass,
        onExpiring: (event) => {
          raised.push(event);
          return Promise.resolve();
        },
      }
    );
    pass.run(now, [monitorOf("m1", https, false, ["down"])]);
    await pass.idle();
    expect(raised).toEqual([]);
    expect(stored.rows.get("m1")).toEqual(soon);
    const later = at(now + 5 * day);
    pass.run(later, [monitorOf("m1", https)]);
    await pass.idle();
    expect(raised.map((event) => event.warning)).toEqual(["threshold"]);
  });
});

describe("a certificate warning with no channel selected", () => {
  const day = 86_400_000;
  const soon = { ...record, validTo: now + 10 * day };

  test("a monitor with no channel raises no warning and remembers none, so selecting a channel later sends the threshold's", async () => {
    const stored = stores([soon]);
    const { at, io } = tlsIo([]);
    const raised: Extract<MonitorEvent, { kind: "certificate_expiring" }>[] =
      [];
    const pass = createCertificatePass(
      { certificates: stored.certificates },
      io,
      {
        ...everyPass,
        onExpiring: (event) => {
          raised.push(event);
          return Promise.resolve();
        },
      }
    );
    const all = [...monitorEventKinds];
    pass.run(now, [monitorOf("m1", https, false, all, [])]);
    await pass.idle();
    expect(raised).toEqual([]);
    expect(stored.rows.get("m1")).toEqual(soon);
    pass.run(at(now + 1), [monitorOf("m1", https, false, all, ["c1"])]);
    await pass.idle();
    expect(raised.map((event) => event.warning)).toEqual(["threshold"]);
    expect(stored.rows.get("m1")?.warned).toBe("threshold");
  });
});

describe("a certificate warning under maintenance", () => {
  const day = 86_400_000;
  const soon = { ...record, validTo: now + 10 * day };

  test("a monitor a window covers raises no warning and remembers none, so the warning goes once the window ends", async () => {
    const stored = stores([soon]);
    const { at, io } = tlsIo([]);
    const covered = new Set(["m1"]);
    const raised: Extract<MonitorEvent, { kind: "certificate_expiring" }>[] =
      [];
    const pass = createCertificatePass(
      { certificates: stored.certificates },
      io,
      {
        ...everyPass,
        covers: (id) => covered.has(id),
        onExpiring: (event) => {
          raised.push(event);
          return Promise.resolve();
        },
      }
    );
    pass.run(now, [monitorOf("m1", https)]);
    await pass.idle();
    expect(raised).toEqual([]);
    expect(stored.rows.get("m1")).toEqual(soon);
    covered.delete("m1");
    pass.run(at(now + 1), [monitorOf("m1", https)]);
    await pass.idle();
    expect(raised.map((event) => event.warning)).toEqual(["threshold"]);
    expect(stored.rows.get("m1")?.warned).toBe("threshold");
  });
});
