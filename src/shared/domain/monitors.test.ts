import { describe, expect, test } from "bun:test";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import {
  arrangeMonitors,
  connectionAddress,
  filterOptions,
  targetOf,
} from "./monitors.ts";

function monitor(
  patch: Partial<Monitor> & { id: string; name: string }
): Monitor {
  return {
    config: {
      assertions: [{ codes: ["2xx"], kind: "status" }],
      captureMode: "off",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      type: "http",
      url: `https://${patch.id}.example.test/`,
    },
    createdAt: 1_700_000_000_000,
    intervalMs: 60_000,
    paused: false,
    retries: 2,
    channels: [],
    events: [...monitorEventKinds],
    tags: [],
    target: `https://${patch.id}.example.test/`,
    timeoutMs: 10_000,
    updatedAt: 1_700_000_000_000,
    ...patch,
  };
}

const api = monitor({
  group: "الإنتاج",
  id: "api",
  name: "واجهة البرمجة",
  tags: ["عام"],
});
const site = monitor({
  createdAt: 1_700_000_001_000,
  group: "الإنتاج",
  id: "site",
  name: "الموقع",
});
const mail = monitor({
  config: { host: "mail.example.test", port: 25, type: "tcp" },
  createdAt: 1_700_000_002_000,
  id: "mail",
  name: "البريد",
  tags: ["عام", "داخلي"],
  target: "mail.example.test:25",
});
const beat = monitor({
  config: { schedule: { everyMs: 300_000, kind: "every" }, type: "heartbeat" },
  createdAt: 1_700_000_003_000,
  group: "المهام",
  id: "beat",
  name: "Nightly backup",
  target: undefined,
});
const all = [mail, beat, api, site];

describe("a monitor's target", () => {
  test("is the URL of an HTTP monitor, host and port of a TCP one, the name of a DNS one, and nothing for a heartbeat", () => {
    expect(
      targetOf({
        assertions: [{ codes: ["2xx"], kind: "status" }],
        captureMode: "off",
        followRedirects: true,
        ignoreTlsErrors: false,
        method: "GET",
        type: "http",
        url: "https://example.test/health",
      })
    ).toBe("https://example.test/health");
    expect(targetOf({ host: "db.example.test", port: 5432, type: "tcp" })).toBe(
      "db.example.test:5432"
    );
    expect(
      targetOf({ name: "example.test", recordType: "MX", type: "dns" })
    ).toBe("example.test");
    expect(
      targetOf({
        schedule: { everyMs: 60_000, kind: "every" },
        type: "heartbeat",
      })
    ).toBe(undefined);
  });

  test("puts a TCP monitor's IPv6 host in brackets so the port reads apart from it", () => {
    expect(targetOf({ host: "2001:db8::1", port: 5432, type: "tcp" })).toBe(
      "[2001:db8::1]:5432"
    );
    expect(targetOf({ host: "192.0.2.1", port: 5432, type: "tcp" })).toBe(
      "192.0.2.1:5432"
    );
  });

  test("is a Docker monitor's container name", () => {
    expect(
      targetOf({
        container: "orders-api",
        endpoint: "/var/run/docker.sock",
        type: "docker",
      })
    ).toBe("orders-api");
  });

  test("is the address a database monitor's connection URL reaches, never the URL", () => {
    expect(
      targetOf({ address: "db.example.test:5432", type: "postgres" })
    ).toBe("db.example.test:5432");
    expect(targetOf({ type: "redis" })).toBe(undefined);
  });
});

describe("what the list shows of a connection URL", () => {
  test("is its host and port, never the user, the password, the database or the options", () => {
    expect(
      connectionAddress(
        "postgres",
        "postgres://watcher:s3cret@db.example.test:6543/app?sslmode=require"
      )
    ).toBe("db.example.test:6543");
  });

  test("names the check type's own port when the URL names none", () => {
    expect(
      connectionAddress("postgres", "postgresql://db.example.test/app")
    ).toBe("db.example.test:5432");
    expect(connectionAddress("mysql", "mysql://u:p@db.example.test/app")).toBe(
      "db.example.test:3306"
    );
    expect(connectionAddress("redis", "rediss://:p@cache.example.test")).toBe(
      "cache.example.test:6379"
    );
  });

  test("keeps an IPv6 address in its brackets", () => {
    expect(connectionAddress("redis", "redis://[2001:db8::1]:6380")).toBe(
      "[2001:db8::1]:6380"
    );
  });
});

describe("the monitors list", () => {
  test("is sorted by name under the locale's collation by default", () => {
    expect(arrangeMonitors(all, {}, "ar").map((m) => m.id)).toEqual([
      "mail",
      "site",
      "api",
      "beat",
    ]);
  });

  test("newest first puts the last created monitor on top", () => {
    expect(
      arrangeMonitors(all, { sort: "newest" }, "ar").map((m) => m.id)
    ).toEqual(["beat", "mail", "site", "api"]);
  });

  test("a search matches the name or the target, anywhere, whatever the case", () => {
    expect(
      arrangeMonitors(all, { q: "البريد" }, "ar").map((m) => m.id)
    ).toEqual(["mail"]);
    expect(
      arrangeMonitors(all, { q: "EXAMPLE.TEST:25" }, "ar").map((m) => m.id)
    ).toEqual(["mail"]);
    expect(
      arrangeMonitors(all, { q: "nightly" }, "ar").map((m) => m.id)
    ).toEqual(["beat"]);
    expect(arrangeMonitors(all, { q: "nothing" }, "ar")).toEqual([]);
  });

  test("a group filter keeps the monitors in that group and a tag filter those carrying the tag", () => {
    expect(
      arrangeMonitors(all, { group: "الإنتاج" }, "ar").map((m) => m.id)
    ).toEqual(["site", "api"]);
    expect(arrangeMonitors(all, { tag: "عام" }, "ar").map((m) => m.id)).toEqual(
      ["mail", "api"]
    );
    expect(
      arrangeMonitors(all, { group: "الإنتاج", tag: "عام" }, "ar").map(
        (m) => m.id
      )
    ).toEqual(["api"]);
  });

  test("a search reads the name and the target only, never a group or a tag", () => {
    expect(arrangeMonitors(all, { q: "الإنتاج" }, "ar")).toEqual([]);
    expect(arrangeMonitors(all, { q: "داخلي" }, "ar")).toEqual([]);
  });

  test("a filter naming an unknown group or tag lists nothing", () => {
    expect(arrangeMonitors(all, { group: "غير موجود" }, "ar")).toEqual([]);
    expect(arrangeMonitors(all, { tag: "غير موجود" }, "ar")).toEqual([]);
  });

  test("does not change the list it was given", () => {
    const copy = [...all];
    arrangeMonitors(all, { sort: "newest" }, "ar");
    expect(all).toEqual(copy);
  });
});

describe("the filters' options", () => {
  test("are every group and every tag a listed monitor carries, once each, sorted under the locale", () => {
    expect(filterOptions(all, "ar")).toEqual({
      groups: ["الإنتاج", "المهام"],
      tags: ["داخلي", "عام"],
    });
  });

  test("are empty for an empty list", () => {
    expect(filterOptions([], "ar")).toEqual({ groups: [], tags: [] });
  });
});
