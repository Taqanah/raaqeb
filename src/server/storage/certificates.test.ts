import { afterEach, describe, expect, test } from "bun:test";
import type { CertificateRecord } from "@/shared/schemas/certificate.ts";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import {
  CertificateShapeError,
  type CertificatesRepository,
  certificatesRepository,
} from "./certificates.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { type MonitorsRepository, monitorsRepository } from "./monitors.ts";
import type { DatabaseLocation } from "./storage.ts";

let open:
  | {
      connection: Connection;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

const site: MonitorInput = {
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    tlsExpiryDays: 14,
    type: "http",
    url: "https://example.test/",
  },
  intervalMs: 60_000,
  name: "Site",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 10_000,
};

async function repositories(): Promise<{
  certificates: CertificatesRepository;
  location: DatabaseLocation;
  monitors: MonitorsRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection, location: scratch.location };
  await migrateDatabase(connection);
  const run = executor(connection);
  let nextId = 0;
  return {
    certificates: certificatesRepository(run),
    location: scratch.location,
    monitors: monitorsRepository(
      run,
      () => 1_700_000_000_000,
      () => {
        nextId += 1;
        return `id-${String(nextId).padStart(3, "0")}`;
      }
    ),
  };
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const now = 1_700_000_000_000;

function record(
  monitorId: string,
  more: Partial<CertificateRecord> = {}
): CertificateRecord {
  return {
    fingerprint: "61:53:A9:6F",
    issuer: "C=US, O=SSL Corporation, CN=Cloudflare TLS Issuing ECC CA 3",
    lastSeenAt: now,
    monitorId,
    names: ["example.test", "*.example.test"],
    subject: "CN=example.test",
    validFrom: now - 30 * 86_400_000,
    validTo: now + 60 * 86_400_000,
    ...more,
  };
}

async function rowCount(location: DatabaseLocation): Promise<number> {
  const [row] = await runSql(
    location,
    "SELECT count(*) AS n FROM certificate_records"
  );
  return Number(row?.n);
}

describe("the certificate records", () => {
  test("a stored record reads back whole, and a monitor without one reads as nothing", async () => {
    const { certificates, monitors } = await repositories();
    const a = await monitors.create(site);
    await certificates.replace(record(a.id));
    expect(await certificates.find(a.id)).toEqual(record(a.id));
    expect(await certificates.find("missing")).toBeUndefined();
  });

  test("a record with a new fingerprint replaces the monitor's previous one, whole, leaving one row", async () => {
    const { certificates, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await certificates.replace(record(a.id));
    const renewed = record(a.id, {
      fingerprint: "AA:BB",
      lastSeenAt: now + 1,
      names: ["example.test"],
      validTo: now + 120 * 86_400_000,
    });
    await certificates.replace(renewed);
    expect(await certificates.find(a.id)).toEqual(renewed);
    expect(await rowCount(location)).toBe(1);
  });

  test("the list holds every monitor's record", async () => {
    const { certificates, monitors } = await repositories();
    const a = await monitors.create(site);
    const b = await monitors.create({ ...site, name: "Other" });
    await certificates.replace(record(a.id));
    await certificates.replace(record(b.id, { fingerprint: "CC:DD" }));
    const listed = await certificates.list();
    expect(
      listed.toSorted((x, y) => x.monitorId.localeCompare(y.monitorId))
    ).toEqual([record(a.id), record(b.id, { fingerprint: "CC:DD" })]);
  });

  test("removing a record leaves the monitor without one; removing twice is fine", async () => {
    const { certificates, monitors } = await repositories();
    const a = await monitors.create(site);
    await certificates.replace(record(a.id));
    await certificates.remove(a.id);
    await certificates.remove(a.id);
    expect(await certificates.find(a.id)).toBeUndefined();
  });

  test("deleting the monitor deletes its record", async () => {
    const { certificates, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await certificates.replace(record(a.id));
    await monitors.remove([a.id]);
    expect(await rowCount(location)).toBe(0);
  });

  test("a stored names column that no longer parses throws a shape error naming the monitor", async () => {
    const { certificates, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await certificates.replace(record(a.id));
    await runSql(
      location,
      "UPDATE certificate_records SET names = ? WHERE monitor_id = ?",
      ["not json", a.id]
    );
    const read = certificates.find(a.id);
    await expect(read).rejects.toBeInstanceOf(CertificateShapeError);
    await expect(read).rejects.toMatchObject({ monitorId: a.id });
  });
});

describe("the warnings a certificate got", () => {
  test("a warning sent is remembered with the certificate and reads back; a new record has none", async () => {
    const { certificates, monitors } = await repositories();
    const a = await monitors.create(site);
    await certificates.replace(record(a.id));
    expect((await certificates.find(a.id))?.warned).toBeUndefined();
    expect(await certificates.warned(a.id, "61:53:A9:6F", "threshold")).toBe(
      true
    );
    expect(await certificates.find(a.id)).toEqual(
      record(a.id, { warned: "threshold" })
    );
    expect(await certificates.warned(a.id, "61:53:A9:6F", "last_day")).toBe(
      true
    );
    expect((await certificates.list())[0]?.warned).toBe("last_day");
  });

  test("a later read of the same certificate keeps the warning it got", async () => {
    const { certificates, monitors } = await repositories();
    const a = await monitors.create(site);
    await certificates.replace(record(a.id));
    await certificates.warned(a.id, "61:53:A9:6F", "threshold");
    await certificates.replace(record(a.id, { lastSeenAt: now + 1 }));
    expect(await certificates.find(a.id)).toEqual(
      record(a.id, { lastSeenAt: now + 1, warned: "threshold" })
    );
  });

  test("a renewed certificate, with a new fingerprint, starts over with no warning", async () => {
    const { certificates, monitors } = await repositories();
    const a = await monitors.create(site);
    await certificates.replace(record(a.id));
    await certificates.warned(a.id, "61:53:A9:6F", "last_day");
    await certificates.replace(record(a.id, { fingerprint: "AA:BB" }));
    expect(await certificates.find(a.id)).toEqual(
      record(a.id, { fingerprint: "AA:BB" })
    );
  });

  test("a warning for a certificate that is no longer the monitor's is not recorded", async () => {
    const { certificates, monitors } = await repositories();
    const a = await monitors.create(site);
    expect(await certificates.warned(a.id, "61:53:A9:6F", "threshold")).toBe(
      false
    );
    await certificates.replace(record(a.id, { fingerprint: "AA:BB" }));
    expect(await certificates.warned(a.id, "61:53:A9:6F", "threshold")).toBe(
      false
    );
    expect(await certificates.find(a.id)).toEqual(
      record(a.id, { fingerprint: "AA:BB" })
    );
  });

  test("a stored warning this version does not know throws a shape error naming the monitor", async () => {
    const { certificates, location, monitors } = await repositories();
    const a = await monitors.create(site);
    await certificates.replace(record(a.id));
    await runSql(
      location,
      "UPDATE certificate_records SET warned = ? WHERE monitor_id = ?",
      [7, a.id]
    );
    await expect(certificates.find(a.id)).rejects.toMatchObject({
      monitorId: a.id,
    });
  });
});
