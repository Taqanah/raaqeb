import { afterEach, describe, expect, test } from "bun:test";
import {
  checksEveryMinute,
  d0,
  day,
  hour,
  type PagesScratch,
  scratchPages,
  site,
} from "@/server/pages/fixture.ts";
import { runSql } from "@/server/storage/fixture.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { contentType } from "./exposition.ts";
import { readSamples, scrape } from "./scrape.ts";
import { makeMetricsToken } from "./token.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const today = d0 + day;
const noon = today + 12 * hour;

async function install() {
  scratch = await scratchPages(today);
  const { storage } = scratch;
  const made = await makeMetricsToken(storage);
  if (!made.ok) {
    throw new Error("no token made");
  }
  return { bearer: `Bearer ${made.token}`, storage };
}

describe("a scrape request", () => {
  test("is not found while the endpoint is off, whatever it carries", async () => {
    scratch = await scratchPages(today);
    const { storage } = scratch;
    expect((await scrape(storage, null, noon)).status).toBe(404);
    expect((await scrape(storage, "Bearer x", noon)).status).toBe(404);
  });

  test("is refused with 401 and a bearer challenge for a missing or wrong token, and reads no monitor", async () => {
    const { storage } = await install();
    const reads: string[] = [];
    const watched = {
      ...storage,
      certificates: {
        ...storage.certificates,
        list: () => {
          reads.push("certificates");
          return storage.certificates.list();
        },
      },
      checks: {
        ...storage.checks,
        latest: () => {
          reads.push("checks");
          return storage.checks.latest();
        },
      },
      monitors: {
        ...storage.monitors,
        list: () => {
          reads.push("monitors");
          return storage.monitors.list();
        },
      },
    };
    for (const authorization of [null, "Bearer wrong", "Basic abc"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each refusal is checked on its own
      const response = await scrape(watched, authorization, noon);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.text()).toBe("");
    }
    expect(reads).toEqual([]);
  });

  test("answers 200 in the Prometheus text format, never cached, for the token", async () => {
    const { bearer, storage } = await install();
    const response = await scrape(storage, bearer, noon);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("raaqeb_build_info{version=");
  });

  test("answers 503 when the database does not answer", async () => {
    const { bearer, storage } = await install();
    const broken = {
      ...storage,
      monitors: {
        ...storage.monitors,
        list: () => Promise.reject(new Error("down")),
      },
    };
    expect((await scrape(broken, bearer, noon)).status).toBe(503);
  });
});

describe("the samples a scrape reads", () => {
  test("a monitor's latest check gives its state, response time and check time, and its group and check type label it", async () => {
    const { storage } = await install();
    const monitor = await storage.monitors.create({ ...site, group: "Core" });
    await checksEveryMinute(storage, monitor, noon - 3 * 60_000, noon, "up");
    const [sample] = await readSamples(storage, noon);
    expect(sample).toMatchObject({
      checkedAt: noon - 60_000,
      checkType: "http",
      group: "Core",
      monitor: "Site",
      paused: false,
      responseMs: 120,
      state: "up",
    });
  });

  test("a paused monitor and a monitor with no check are read as such", async () => {
    const { storage } = await install();
    const fresh = await storage.monitors.create({ ...site, name: "Fresh" });
    const stopped = await storage.monitors.create({ ...site, name: "Stopped" });
    await storage.monitors.pause([stopped.id]);
    const samples = await readSamples(storage, noon);
    expect(samples.find((s) => s.monitor === fresh.name)).toMatchObject({
      group: "",
      paused: false,
      state: undefined,
    });
    expect(samples.find((s) => s.monitor === stopped.name)?.paused).toBe(true);
  });

  test("the uptime ratio is one minus the outage time over the observed time in the last seven UTC days", async () => {
    const { storage } = await install();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, today, today + 11 * hour, "up");
    await checksEveryMinute(storage, monitor, today + 11 * hour, noon, "down");
    await storage.outages.open(monitor.id, today + 11 * hour, reasons.timeout);
    const [sample] = await readSamples(storage, noon);
    expect(sample?.uptime).toBeCloseTo(11 / 12, 6);
    expect(sample?.state).toBe("down");
  });

  test("a monitor with no observed time has no uptime ratio", async () => {
    const { storage } = await install();
    await storage.monitors.create(site);
    const [sample] = await readSamples(storage, noon);
    expect(sample?.uptime).toBeUndefined();
  });

  test("one monitor's unreadable record leaves that monitor's uptime out, never the scrape of the others", async () => {
    const { bearer, storage } = await install();
    const bad = await storage.monitors.create(site);
    const good = await storage.monitors.create({ ...site, name: "Good" });
    await checksEveryMinute(storage, bad, d0, d0 + 2 * hour, "up");
    await storage.checks.seal(bad.id, d0, 40 * 60_000, []);
    await checksEveryMinute(storage, bad, today, noon, "up");
    await checksEveryMinute(storage, good, today, noon, "up");
    await runSql(
      scratch?.location ?? { backend: "sqlite", file: "" },
      scratch?.location.backend === "postgres"
        ? "UPDATE sealed_days SET chunk = '\\x00ff'::bytea"
        : "UPDATE sealed_days SET chunk = x'00ff'"
    );
    const samples = await readSamples(storage, noon);
    expect(samples.find((s) => s.monitorId === bad.id)?.uptime).toBeUndefined();
    expect(samples.find((s) => s.monitorId === good.id)?.uptime).toBe(1);
    expect((await scrape(storage, bearer, noon)).status).toBe(200);
  });

  test("a scrape reads no row per check: the day's checks stay summed in the database", async () => {
    const { bearer, storage } = await install();
    const monitor = await storage.monitors.create(site);
    await checksEveryMinute(storage, monitor, today, noon, "down");
    const { id } = monitor;
    const refuse = () => {
      throw new Error("a scrape read a row per check");
    };
    const response = await scrape(
      {
        ...storage,
        checks: {
          ...storage.checks,
          range: refuse,
          ranges: refuse,
          recent: refuse,
          series: refuse,
        },
      },
      bearer,
      noon
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(
      `raaqeb_monitor_up{monitor="Site",monitor_id="${id}",group="",check_type="http"} 0`
    );
    expect(text).toContain(
      `raaqeb_monitor_uptime_ratio{monitor="Site",monitor_id="${id}",group="",check_type="http",window="7d"} `
    );
  });

  test("the certificate record gives the expiry", async () => {
    const { storage } = await install();
    const monitor = await storage.monitors.create(site);
    await storage.certificates.replace({
      fingerprint: "AA:BB",
      issuer: "CN=CA",
      lastSeenAt: noon,
      monitorId: monitor.id,
      names: ["example.test"],
      subject: "CN=example.test",
      validFrom: noon - 30 * day,
      validTo: noon + 30 * day,
    });
    const [sample] = await readSamples(storage, noon);
    expect(sample?.certificateExpiresAt).toBe(noon + 30 * day);
  });

  test("one scrape's text carries every monitor", async () => {
    const { bearer, storage } = await install();
    const up = await storage.monitors.create({ ...site, name: "A" });
    const down = await storage.monitors.create({ ...site, name: "B" });
    await checksEveryMinute(storage, up, noon - 120_000, noon, "up");
    await checksEveryMinute(storage, down, noon - 120_000, noon, "down");
    const text = await (await scrape(storage, bearer, noon)).text();
    expect(text).toContain(
      `raaqeb_monitor_up{monitor="A",monitor_id="${up.id}",group="",check_type="http"} 1`
    );
    expect(text).toContain(
      `raaqeb_monitor_up{monitor="B",monitor_id="${down.id}",group="",check_type="http"} 0`
    );
  });

  test("two monitors of one name, as a duplicate or an import makes, are two series by their ids", async () => {
    const { bearer, storage } = await install();
    const first = await storage.monitors.create({ ...site, name: "API" });
    const second = await storage.monitors.create({ ...site, name: "API" });
    await checksEveryMinute(storage, first, noon - 120_000, noon, "up");
    await checksEveryMinute(storage, second, noon - 120_000, noon, "down");
    const text = await (await scrape(storage, bearer, noon)).text();
    expect(text).toContain(
      `raaqeb_monitor_up{monitor="API",monitor_id="${first.id}",group="",check_type="http"} 1`
    );
    expect(text).toContain(
      `raaqeb_monitor_up{monitor="API",monitor_id="${second.id}",group="",check_type="http"} 0`
    );
  });
});
