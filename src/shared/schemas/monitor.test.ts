import { describe, expect, test } from "bun:test";
import {
  connectionUrlFits,
  containerListSchema,
  databaseCheckTypes,
  defaultAssertions,
  groupNameMaxLength,
  isDatabaseCheckType,
  isDockerEndpoint,
  isSocketPath,
  monitorChangeInputSchema,
  monitorConfigSchema,
  monitorEditSchema,
  monitorFieldsSchema,
  monitorIdsSchema,
  monitorInputSchema,
  monitorListSearchSchema,
  monitorTestSchema,
  tagMaxLength,
} from "./monitor.ts";

const http = { type: "http", url: "https://example.test/health" } as const;
const base = {
  config: http,
  intervalMs: 60_000,
  name: "الموقع",
  retries: 2,
  timeoutMs: 10_000,
};

describe("a monitor's input", () => {
  test("carries a name, a check type with its target, a schedule and no tags by default", () => {
    const parsed = monitorInputSchema.parse(base);
    expect(parsed.name).toBe("الموقع");
    expect(parsed.tags).toEqual([]);
    expect(parsed.group).toBe(undefined);
    expect(parsed.degradedMs).toBe(undefined);
  });

  test("trims the name, the group and the tags and refuses an empty name", () => {
    const parsed = monitorInputSchema.parse({
      ...base,
      group: "  الإنتاج ",
      name: "  api  ",
      tags: [" عام "],
    });
    expect(parsed.name).toBe("api");
    expect(parsed.group).toBe("الإنتاج");
    expect(parsed.tags).toEqual(["عام"]);
    expect(monitorInputSchema.safeParse({ ...base, name: "   " }).success).toBe(
      false
    );
  });

  test("keeps the interval between 20 s and 24 h, the timeout between 1 s and 60 s and the retries between 0 and 10", () => {
    const accepts = (patch: Partial<typeof base>) =>
      monitorInputSchema.safeParse({ ...base, ...patch }).success;
    expect(accepts({ intervalMs: 20_000 })).toBe(true);
    expect(accepts({ intervalMs: 19_999 })).toBe(false);
    expect(accepts({ intervalMs: 86_400_000 })).toBe(true);
    expect(accepts({ intervalMs: 86_400_001 })).toBe(false);
    expect(accepts({ timeoutMs: 1000 })).toBe(true);
    expect(accepts({ timeoutMs: 999 })).toBe(false);
    expect(accepts({ timeoutMs: 60_000 })).toBe(true);
    expect(accepts({ timeoutMs: 60_001 })).toBe(false);
    expect(accepts({ retries: 0 })).toBe(true);
    expect(accepts({ retries: 10 })).toBe(true);
    expect(accepts({ retries: 11 })).toBe(false);
    expect(accepts({ retries: 1.5 })).toBe(false);
  });

  test("the degraded threshold is a positive response time up to the longest timeout, or off", () => {
    expect(
      monitorInputSchema.safeParse({ ...base, degradedMs: 800 }).success
    ).toBe(true);
    expect(
      monitorInputSchema.safeParse({ ...base, degradedMs: 60_000 }).success
    ).toBe(true);
    expect(
      monitorInputSchema.safeParse({ ...base, degradedMs: 60_001 }).success
    ).toBe(false);
    expect(
      monitorConfigSchema.safeParse({
        ...http,
        assertions: [{ kind: "response_time_under", ms: 60_001 }],
      }).success
    ).toBe(false);
    expect(
      monitorInputSchema.safeParse({ ...base, degradedMs: 0 }).success
    ).toBe(false);
  });
});

describe("an HTTP monitor's check-type part", () => {
  test("defaults to GET, follow redirects, TLS errors respected, capture off and the 2xx assertion", () => {
    const parsed = monitorConfigSchema.parse(http);
    expect(parsed).toEqual({
      assertions: [...defaultAssertions],
      captureMode: "off",
      followRedirects: true,
      ignoreTlsErrors: false,
      method: "GET",
      type: "http",
      url: "https://example.test/health",
    });
  });

  test("takes only http and https URLs", () => {
    expect(
      monitorConfigSchema.safeParse({ type: "http", url: "ftp://example.test" })
        .success
    ).toBe(false);
    expect(
      monitorConfigSchema.safeParse({ type: "http", url: "example.test" })
        .success
    ).toBe(false);
  });

  test("takes an IP address, a bracketed IPv6 address or localhost as the host, with a port", () => {
    for (const url of [
      "http://127.0.0.1:1/health",
      "http://[::1]:8080/",
      "http://localhost:3000/",
      "https://10.0.0.5/",
    ]) {
      expect(monitorConfigSchema.safeParse({ type: "http", url }).success).toBe(
        true
      );
    }
  });

  test("refuses a URL carrying a user name or a password: credentials are never stored", () => {
    expect(
      monitorConfigSchema.safeParse({
        type: "http",
        url: "https://user:secret@example.test/",
      }).success
    ).toBe(false);
    expect(
      monitorConfigSchema.safeParse({
        type: "http",
        url: "https://user@example.test/",
      }).success
    ).toBe(false);
  });

  test("refuses a URL carrying a password alone", () => {
    expect(
      monitorConfigSchema.safeParse({
        type: "http",
        url: "https://:secret@example.test/",
      }).success
    ).toBe(false);
  });

  test("a status assertion is a class, a code or a range, never anything else", () => {
    const withCodes = (codes: string[]) =>
      monitorConfigSchema.safeParse({
        ...http,
        assertions: [{ codes, kind: "status" }],
      }).success;
    expect(withCodes(["2xx", "301", "400-404"])).toBe(true);
    expect(withCodes(["6xx"])).toBe(false);
    expect(withCodes(["ok"])).toBe(false);
    expect(withCodes([])).toBe(false);
  });

  test("the success rules never become empty", () => {
    expect(
      monitorConfigSchema.safeParse({ ...http, assertions: [] }).success
    ).toBe(false);
  });

  test("the certificate expiry option is a day count when on", () => {
    expect(
      monitorConfigSchema.safeParse({ ...http, tlsExpiryDays: 14 }).success
    ).toBe(true);
    expect(
      monitorConfigSchema.safeParse({ ...http, tlsExpiryDays: 0 }).success
    ).toBe(false);
  });
});

describe("the other check types", () => {
  test("TCP is a host and a port in range", () => {
    expect(
      monitorConfigSchema.safeParse({
        host: "db.example.test",
        port: 5432,
        type: "tcp",
      }).success
    ).toBe(true);
    expect(
      monitorConfigSchema.safeParse({
        host: "db.example.test",
        port: 70_000,
        type: "tcp",
      }).success
    ).toBe(false);
    expect(
      monitorConfigSchema.safeParse({
        host: "not a host",
        port: 80,
        type: "tcp",
      }).success
    ).toBe(false);
  });

  test("a DNS name takes an underscore in any label, so _dmarc and _domainkey records can be watched", () => {
    for (const name of [
      "_dmarc.example.com",
      "selector._domainkey.example.com",
      "s1_2024._domainkey.example.com",
      "_acme-challenge.example.com",
      "_mta-sts.example.com",
      "example.com.",
    ]) {
      expect(
        monitorConfigSchema.safeParse({ name, recordType: "TXT", type: "dns" })
          .success
      ).toBe(true);
    }
  });

  test("a DNS name still refuses what no resolver can query: an empty label, a label over 63 octets, a name over 253, a hyphen at a label's edge, a space", () => {
    const label = "a".repeat(63);
    for (const name of [
      "",
      "_dmarc..example.com",
      ".example.com",
      `${label}a.example.com`,
      `${label}.${label}.${label}.${label}.com`,
      "-_dmarc.example.com",
      "_dmarc-.example.com",
      "_dmarc .example.com",
      "_dmarc.exa!mple.com",
    ]) {
      expect(monitorConfigSchema.safeParse({ name, type: "dns" }).success).toBe(
        false
      );
    }
  });

  test("a TCP host keeps the host-name rule: no underscore", () => {
    expect(
      monitorConfigSchema.safeParse({
        host: "_dmarc.example.com",
        port: 25,
        type: "tcp",
      }).success
    ).toBe(false);
  });

  test("a TCP host is a host name, an IPv4 address or a bare IPv6 address, never one in brackets", () => {
    for (const host of [
      "192.0.2.1",
      "mail.example.test",
      "::1",
      "2001:db8::1",
    ]) {
      expect(
        monitorConfigSchema.safeParse({ host, port: 25, type: "tcp" }).success
      ).toBe(true);
    }
    for (const host of ["[::1]", "[2001:db8::1]", "2001:db8::1::", "::g"]) {
      expect(
        monitorConfigSchema.safeParse({ host, port: 25, type: "tcp" }).success
      ).toBe(false);
    }
  });

  test("DNS is a name with a record type, A by default, and optional expected value and resolver", () => {
    const parsed = monitorConfigSchema.parse({
      name: "example.test",
      type: "dns",
    });
    expect(parsed).toEqual({
      name: "example.test",
      recordType: "A",
      type: "dns",
    });
    expect(
      monitorConfigSchema.safeParse({
        name: "example.test",
        recordType: "SRV",
        type: "dns",
      }).success
    ).toBe(false);
  });

  test("a heartbeat is a schedule, every N or a cron expression, with an optional grace period", () => {
    expect(
      monitorConfigSchema.safeParse({
        schedule: { everyMs: 300_000, kind: "every" },
        type: "heartbeat",
      }).success
    ).toBe(true);
    expect(
      monitorConfigSchema.safeParse({
        graceMs: 60_000,
        schedule: { expression: "*/5 * * * *", kind: "cron" },
        type: "heartbeat",
      }).success
    ).toBe(true);
    expect(
      monitorConfigSchema.safeParse({
        schedule: { everyMs: 1000, kind: "every" },
        type: "heartbeat",
      }).success
    ).toBe(false);
  });

  test("a heartbeat's every N runs from 20 seconds to 30 days; a longer schedule is a cron expression", () => {
    const every = (everyMs: number) =>
      monitorConfigSchema.safeParse({
        schedule: { everyMs, kind: "every" },
        type: "heartbeat",
      }).success;
    expect(every(20_000)).toBe(true);
    expect(every(19_999)).toBe(false);
    expect(every(30 * 86_400_000)).toBe(true);
    expect(every(30 * 86_400_000 + 1)).toBe(false);
  });

  test("a heartbeat's cron expression is refused when Bun's grammar does not read it, and kept trimmed when it does", () => {
    const cron = (expression: string) =>
      monitorConfigSchema.safeParse({
        schedule: { expression, kind: "cron" },
        type: "heartbeat",
      });
    expect(cron("every day").success).toBe(false);
    expect(cron("* * * *").success).toBe(false);
    expect(cron(" 0 3 * * * ").data).toEqual({
      schedule: { expression: "0 3 * * *", kind: "cron" },
      type: "heartbeat",
    });
  });

  test("a heartbeat's grace period is positive and no longer than the longest period", () => {
    const grace = (graceMs: number) =>
      monitorConfigSchema.safeParse({
        graceMs,
        schedule: { everyMs: 60_000, kind: "every" },
        type: "heartbeat",
      }).success;
    expect(grace(1)).toBe(true);
    expect(grace(0)).toBe(false);
    expect(grace(30 * 86_400_000)).toBe(true);
    expect(grace(30 * 86_400_000 + 1)).toBe(false);
  });

  test("an unknown check type is refused", () => {
    expect(
      monitorConfigSchema.safeParse({ host: "example.test", type: "ping" })
        .success
    ).toBe(false);
  });
});

describe("a bulk action's ids", () => {
  test("take as many ids as the list shows, so select-all on a large install works", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `id-${i}`);
    expect(monitorIdsSchema.safeParse({ ids }).success).toBe(true);
    expect(monitorIdsSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});

describe("the list's search parameters", () => {
  test("an absent, empty or malformed parameter means no filter, never an error", () => {
    expect(monitorListSearchSchema.parse({})).toEqual({});
    expect(
      monitorListSearchSchema.parse({ q: "  ", sort: "size", tag: "" })
    ).toEqual({});
    expect(monitorListSearchSchema.parse({ group: ["a"] })).toEqual({});
  });

  test("keeps a query, a group, a tag and a known sort", () => {
    expect(
      monitorListSearchSchema.parse({
        group: "الإنتاج",
        q: " api ",
        sort: "newest",
        tag: "عام",
      })
    ).toEqual({ group: "الإنتاج", q: "api", sort: "newest", tag: "عام" });
  });
});

describe("the fields the monitor form adds", () => {
  test("a retention override is a whole number of days from 1 to 3650, and absent follows the install default", () => {
    expect(monitorInputSchema.parse(base).retentionDays).toBe(undefined);
    for (const days of [1, 30, 3650]) {
      expect(
        monitorInputSchema.parse({ ...base, retentionDays: days }).retentionDays
      ).toBe(days);
    }
    for (const days of [0, 3651, 1.5]) {
      expect(
        monitorInputSchema.safeParse({ ...base, retentionDays: days }).success
      ).toBe(false);
    }
  });

  test("the credentials are optional and never part of the stored fields", () => {
    expect(monitorInputSchema.parse(base).credentials).toBe(undefined);
    const parsed = monitorInputSchema.parse({
      ...base,
      credentials: { auth: { kind: "bearer", token: "t" } },
    });
    expect(parsed.credentials).toEqual({
      auth: { kind: "bearer", token: "t" },
      headers: [],
    });
    expect("credentials" in monitorFieldsSchema.parse(parsed)).toBe(false);
  });

  test("a JSON pattern that does not compile is refused, so it never fails every check", () => {
    const rule = (pattern: string) =>
      monitorConfigSchema.safeParse({
        ...http,
        assertions: [{ kind: "json_matches", path: "status", pattern }],
      }).success;
    expect(rule("^ok$")).toBe(true);
    expect(rule("(unclosed")).toBe(false);
    expect(rule("[z-a]")).toBe(false);
  });

  test("a JSON path the check cannot read is refused on its own field, so it never fails every check as not found", () => {
    const issues = (path: string) =>
      monitorInputSchema
        .safeParse({
          ...base,
          config: {
            ...http,
            assertions: [
              { kind: "json_equals", path, value: "ok" },
              { kind: "json_matches", path, pattern: "^ok$" },
            ],
          },
        })
        .error?.issues.map((issue) => issue.path.join("."));
    expect(issues("data.items[0].status")).toBe(undefined);
    expect(issues("data..items")).toEqual([
      "config.assertions.0.path",
      "config.assertions.1.path",
    ]);
  });

  test("a stored monitor whose JSON path the check cannot read still reads, so one row never stops the scheduler or the list", () => {
    expect(
      monitorConfigSchema.safeParse({
        ...http,
        assertions: [{ kind: "json_equals", path: "data..items", value: "ok" }],
      }).success
    ).toBe(true);
  });

  test("an edit and a test now refuse a JSON path the check cannot read too", () => {
    const input = {
      ...base,
      config: {
        ...http,
        assertions: [{ kind: "json_equals", path: "data..items", value: "" }],
      },
    };
    expect(monitorEditSchema.safeParse({ id: "m", input }).success).toBe(false);
    expect(monitorTestSchema.safeParse({ input }).success).toBe(false);
  });

  test("an assertion that is not even its type is refused without the path rule running on it", () => {
    for (const assertions of [
      [{ kind: "json_equals", path: 5, value: "" }],
      [{ kind: "json_sideways", path: "data..items" }],
      "not a list",
    ]) {
      const parsed = monitorInputSchema.safeParse({
        ...base,
        config: { ...http, assertions },
      });
      expect(parsed.success).toBe(false);
      expect(
        parsed.error?.issues.some((issue) => issue.code === "custom")
      ).toBe(false);
    }
  });

  test("an input that is not an object is refused, never thrown, at the top and inside an edit or a test now", () => {
    for (const input of [null, "x", [], 5, { ...base, config: null }]) {
      expect(monitorInputSchema.safeParse(input).success).toBe(false);
      expect(monitorEditSchema.safeParse({ id: "m", input }).success).toBe(
        false
      );
      expect(monitorTestSchema.safeParse({ input }).success).toBe(false);
    }
    for (const assertions of [null, [null], ["x"], [5]]) {
      expect(
        monitorInputSchema.safeParse({
          ...base,
          config: { ...http, assertions },
        }).success
      ).toBe(false);
    }
  });

  test("a custom DNS resolver is an IP address with an optional port, as node:dns accepts it", () => {
    const resolver = (value: string) =>
      monitorConfigSchema.safeParse({
        name: "example.test",
        resolver: value,
        type: "dns",
      }).success;
    for (const value of [
      "192.0.2.53",
      "192.0.2.53:5353",
      "2001:db8::1",
      "[2001:db8::1]:53",
    ]) {
      expect(resolver(value)).toBe(true);
    }
    for (const value of [
      "dns.example.test",
      "192.0.2.53:0",
      "192.0.2.53:70000",
      "[2001:db8::1]",
      "1.2.3",
    ]) {
      expect(resolver(value)).toBe(false);
    }
  });
});

describe("an HTTP monitor's request body", () => {
  test("an empty request body is refused, so a body is either absent or text and every stored one round-trips through the form", () => {
    const body = (value: string) =>
      monitorConfigSchema.safeParse({ ...http, body: value }).success;
    expect(body("")).toBe(false);
    expect(body("{}")).toBe(true);
  });
});

describe("a monitor's events and reminder", () => {
  test("a monitor has all five events on and no reminder by default", () => {
    const parsed = monitorInputSchema.parse(base);
    expect(parsed.events).toEqual([
      "down",
      "recovered",
      "degraded_started",
      "degraded_ended",
      "certificate_expiring",
    ]);
    expect(parsed.reminderMs).toBe(undefined);
  });

  test("the events switched on keep the canonical order, once each, whatever order they came in", () => {
    expect(
      monitorInputSchema.parse({
        ...base,
        events: ["recovered", "down", "recovered"],
      }).events
    ).toEqual(["down", "recovered"]);
    expect(monitorInputSchema.parse({ ...base, events: [] }).events).toEqual(
      []
    );
    expect(
      monitorInputSchema.safeParse({ ...base, events: ["paused"] }).success
    ).toBe(false);
  });

  test("a reminder repeats every 5 minutes at the most often and once a day at the least", () => {
    for (const ms of [5 * 60_000, 3_600_000, 86_400_000]) {
      expect(
        monitorInputSchema.parse({ ...base, reminderMs: ms }).reminderMs
      ).toBe(ms);
    }
    for (const ms of [5 * 60_000 - 1, 86_400_001, 0, 90_000.5]) {
      expect(
        monitorInputSchema.safeParse({ ...base, reminderMs: ms }).success
      ).toBe(false);
    }
  });
});

describe("the selection bar's change", () => {
  const ids = ["a", "b"];
  const parse = (change: unknown) =>
    monitorChangeInputSchema.safeParse({ change, ids });

  test("a tag added is trimmed, and refused when empty, longer than a tag may be, or holding a Latin or an Arabic comma, as the form would split it", () => {
    const added = parse({ kind: "add_tag", tag: "  حرج  " });
    expect(added.success && added.data.change).toEqual({
      kind: "add_tag",
      tag: "حرج",
    });
    for (const tag of ["", "   ", "x".repeat(tagMaxLength + 1), "a,b", "أ،ب"]) {
      expect(parse({ kind: "add_tag", tag }).success).toBe(false);
    }
    expect(
      parse({ kind: "add_tag", tag: "x".repeat(tagMaxLength) }).success
    ).toBe(true);
  });

  test("a tag removed is any name a tag may have, so one stored with a comma can still be removed", () => {
    expect(parse({ kind: "remove_tag", tag: "a,b" }).success).toBe(true);
    expect(parse({ kind: "remove_tag", tag: " " }).success).toBe(false);
  });

  test("a group is trimmed and refused when longer than a group name may be; none takes the monitors out of theirs", () => {
    const set = parse({ group: " الإنتاج ", kind: "set_group" });
    expect(set.success && set.data.change).toEqual({
      group: "الإنتاج",
      kind: "set_group",
    });
    expect(parse({ kind: "set_group" }).success).toBe(true);
    expect(
      parse({ group: "x".repeat(groupNameMaxLength + 1), kind: "set_group" })
        .success
    ).toBe(false);
  });

  test("a channel is named by its id; a change with no monitors or an unknown kind is refused", () => {
    expect(parse({ channel: "c", kind: "add_channel" }).success).toBe(true);
    expect(parse({ channel: "", kind: "remove_channel" }).success).toBe(false);
    expect(parse({ kind: "pause" }).success).toBe(false);
    expect(
      monitorChangeInputSchema.safeParse({
        change: { channel: "c", kind: "add_channel" },
        ids: [],
      }).success
    ).toBe(false);
  });
});

describe("a database monitor", () => {
  const postgres = { ...base, config: { type: "postgres" } } as const;

  test("Postgres, MySQL and Redis are check types of a database monitor, and no other is", () => {
    expect(databaseCheckTypes).toEqual(["postgres", "mysql", "redis"]);
    for (const type of databaseCheckTypes) {
      expect(isDatabaseCheckType(type)).toBe(true);
      expect(monitorConfigSchema.safeParse({ type }).success).toBe(true);
    }
    for (const type of ["http", "tcp", "dns", "heartbeat", "mongodb"]) {
      expect(isDatabaseCheckType(type)).toBe(false);
    }
  });

  test("the query and the expected value are optional, trimmed, and never empty", () => {
    const parsed = monitorConfigSchema.parse({
      expected: " ok ",
      query: "  SELECT status FROM health  ",
      type: "postgres",
    });
    expect(parsed).toEqual({
      expected: "ok",
      query: "SELECT status FROM health",
      type: "postgres",
    });
    expect(
      monitorConfigSchema.safeParse({ query: "  ", type: "mysql" }).success
    ).toBe(false);
    expect(
      monitorConfigSchema.safeParse({ expected: "", type: "redis" }).success
    ).toBe(false);
  });

  test("an expected value is no longer than an observed one may be, so the failure detail holds it whole", () => {
    const accepts = (expected: string) =>
      monitorConfigSchema.safeParse({ expected, type: "postgres" }).success;
    expect(accepts("x".repeat(200))).toBe(true);
    expect(accepts("x".repeat(201))).toBe(false);
  });

  test("a connection URL fits its check type by its scheme and names a host", () => {
    expect(
      connectionUrlFits("postgres", "postgres://u:p@db.example.test:5432/app")
    ).toBe(true);
    expect(connectionUrlFits("postgres", "postgresql://db.example.test")).toBe(
      true
    );
    expect(connectionUrlFits("mysql", "mysql://u:p@db.example.test/app")).toBe(
      true
    );
    expect(connectionUrlFits("mysql", "mariadb://db.example.test")).toBe(true);
    expect(
      connectionUrlFits("redis", "redis://:p@cache.example.test:6379")
    ).toBe(true);
    expect(connectionUrlFits("redis", "rediss://cache.example.test")).toBe(
      true
    );
    expect(connectionUrlFits("redis", "postgres://db.example.test")).toBe(
      false
    );
    expect(connectionUrlFits("postgres", "mysql://db.example.test")).toBe(
      false
    );
    // No host: a socket path, or the environment's defaults, which could reach Raaqeb's own database.
    expect(connectionUrlFits("postgres", "postgres:///app")).toBe(false);
    expect(connectionUrlFits("postgres", "not a url")).toBe(false);
  });

  test("a Redis URL names its database by number or not at all, as Bun's client reads it", () => {
    expect(connectionUrlFits("redis", "redis://cache.example.test/0")).toBe(
      true
    );
    expect(connectionUrlFits("redis", "redis://cache.example.test/15")).toBe(
      true
    );
    expect(connectionUrlFits("redis", "redis://cache.example.test/")).toBe(
      true
    );
    // Bun refuses a name before it connects (Bun 1.4.2: "Invalid database number").
    expect(connectionUrlFits("redis", "redis://cache.example.test/app")).toBe(
      false
    );
  });

  test("a posted connection URL that does not fit the check type is refused on its own field", () => {
    const parsed = monitorInputSchema.safeParse({
      ...postgres,
      credentials: { url: "redis://cache.example.test" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "credentials.url",
    ]);
    expect(
      monitorInputSchema.safeParse({
        ...postgres,
        credentials: { url: "postgres://u:p@db.example.test/app" },
      }).success
    ).toBe(true);
  });

  test("a database monitor may post no connection URL, which keeps the stored one", () => {
    expect(monitorInputSchema.safeParse(postgres).success).toBe(true);
  });

  test("the connection URL is never part of the stored fields", () => {
    const fields = monitorFieldsSchema.parse({
      ...postgres,
      credentials: { url: "postgres://u:p@db.example.test/app" },
    });
    expect(JSON.stringify(fields)).not.toContain("db.example.test");
  });
});

describe("a Docker monitor", () => {
  const docker = (patch: Record<string, unknown> = {}) =>
    monitorConfigSchema.safeParse({
      container: "web",
      endpoint: "/var/run/docker.sock",
      type: "docker",
      ...patch,
    });

  test("names the daemon's endpoint and the container, and nothing else is stored", () => {
    expect(
      monitorConfigSchema.parse({
        container: " web ",
        endpoint: " /var/run/docker.sock ",
        type: "docker",
      })
    ).toEqual({
      container: "web",
      endpoint: "/var/run/docker.sock",
      type: "docker",
    });
  });

  test("an endpoint is a socket's absolute path or an http or https URL", () => {
    for (const endpoint of [
      "/var/run/docker.sock",
      "/run/user/1000/podman/podman.sock",
      "http://socket-proxy:2375",
      "https://docker.example.test/engine/",
      "http://[2001:db8::1]:2375",
    ]) {
      expect(isDockerEndpoint(endpoint)).toBe(true);
    }
    for (const endpoint of [
      "var/run/docker.sock",
      "unix:///var/run/docker.sock",
      "tcp://192.0.2.10:2375",
      "ftp://docker.example.test",
      "http://",
      "",
    ]) {
      expect(isDockerEndpoint(endpoint)).toBe(false);
    }
  });

  test("a URL carries no user name, password, query or fragment, which would be stored in clear or lost", () => {
    for (const endpoint of [
      "http://watcher:s3cret@proxy:2375",
      "http://:s3cret@proxy:2375",
      "http://proxy:2375/?token=s3cret",
      "http://proxy:2375/#engine",
      // An empty query or fragment parses as none, and the raw text would still reach the request.
      "http://proxy:2375?",
      "http://proxy:2375/docker#",
    ]) {
      expect(isDockerEndpoint(endpoint)).toBe(false);
      expect(docker({ endpoint }).success).toBe(false);
    }
  });

  test("a socket's path is told from a URL", () => {
    expect(isSocketPath("/var/run/docker.sock")).toBe(true);
    expect(isSocketPath("http://proxy:2375")).toBe(false);
  });

  test("a container is named as Docker names one, with no leading slash", () => {
    for (const container of ["web", "my_app-1.2", "Raaqeb2"]) {
      expect(docker({ container }).success).toBe(true);
    }
    for (const container of ["/web", "w", "", "web app", "-web", "ويب"]) {
      expect(docker({ container }).success).toBe(false);
    }
    expect(docker({ container: "a".repeat(256) }).success).toBe(false);
  });

  test("the form's container list posts an endpoint by the same rule", () => {
    expect(
      containerListSchema.safeParse({ endpoint: "/var/run/docker.sock" })
        .success
    ).toBe(true);
    expect(
      containerListSchema.safeParse({ endpoint: "http://u:p@proxy" }).success
    ).toBe(false);
  });
});
