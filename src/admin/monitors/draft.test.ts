import { describe, expect, test } from "bun:test";
import {
  type CredentialsView,
  noCredentials,
} from "@/shared/schemas/credentials.ts";
import type {
  Monitor,
  MonitorFields,
  MonitorTest,
} from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import {
  assertionStates,
  captureBytesPerDay,
  copyDraftOf,
  curlLine,
  draftOf,
  durationDraft,
  type FieldErrors,
  inputOf,
  intervalChoicesMs,
  type MonitorDraft,
  newAssertion,
  reminderChoicesMs,
  tagsOf,
  withChannel,
  withEvent,
  withField,
} from "./draft.ts";

const stored = {
  createdAt: 1,
  id: "m1",
  paused: false,
  target: undefined,
  updatedAt: 2,
} as const;

const httpFields: MonitorFields = {
  config: {
    assertions: [
      { codes: ["2xx", "301"], kind: "status" },
      { kind: "body_contains", text: "ok" },
      { kind: "body_not_contains", text: "error" },
      { kind: "json_equals", path: "data.status", value: "up" },
      { kind: "json_matches", path: "version", pattern: "^2\\." },
      { kind: "header_equals", name: "content-type", value: "text/html" },
      { kind: "response_time_under", ms: 800 },
    ],
    body: '{"ping":true}',
    captureMode: "on_failure",
    followRedirects: false,
    ignoreTlsErrors: true,
    method: "POST",
    tlsExpiryDays: 21,
    type: "http",
    url: "https://api.example.test/health",
  },
  degradedMs: 400,
  description: "واجهة الدفع",
  group: "الإنتاج",
  intervalMs: 300_000,
  name: "بوابة الدفع",
  retentionDays: 365,
  retries: 3,
  channels: [],
  events: [...monitorEventKinds],
  tags: ["دفع", "عام"],
  timeoutMs: 15_000,
};

const tcpFields: MonitorFields = {
  config: { host: "mail.example.test", port: 587, type: "tcp" },
  intervalMs: 60_000,
  name: "البريد",
  retries: 0,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 5000,
};

const dnsFields: MonitorFields = {
  config: {
    expected: "192.0.2.10",
    name: "example.test",
    recordType: "AAAA",
    resolver: "192.0.2.53:5353",
    type: "dns",
  },
  intervalMs: 3_600_000,
  name: "النطاق",
  retries: 1,
  channels: [],
  events: [...monitorEventKinds],
  tags: ["dns"],
  timeoutMs: 2000,
};

const monitorOf = (fields: MonitorFields): Monitor => ({
  ...fields,
  ...stored,
});

/** The draft of a new monitor with some fields typed. */
const typed = (fields: Partial<MonitorDraft>): MonitorDraft => ({
  ...draftOf(undefined, noCredentials),
  name: "الموقع",
  url: "https://example.test/",
  ...fields,
});

/** The refusals of a draft, or the test fails when it parses. */
function errorsOf(draft: MonitorDraft): FieldErrors {
  const parsed = inputOf(draft);
  if (parsed.ok) {
    throw new Error("the draft parsed");
  }
  return parsed.errors;
}

describe("a new monitor's draft", () => {
  test("starts as an HTTP GET with the 2xx assertion, capture off, and the default values", () => {
    const draft = draftOf(undefined, noCredentials);
    expect(draft.type).toBe("http");
    expect(draft.method).toBe("GET");
    expect(draft.followRedirects).toBe(true);
    expect(draft.ignoreTlsErrors).toBe(false);
    expect(draft.captureMode).toBe("off");
    expect(draft.assertions.map((row) => [row.kind, row.codes])).toEqual([
      ["status", "2xx"],
    ]);
    expect(draft.intervalMs).toBe(60_000);
    expect(draft.timeoutSeconds).toBe("10");
    expect(draft.retries).toBe("2");
    expect(draft.degradedMs).toBe("");
    expect(draft.retentionDays).toBe("");
    expect(draft.tlsExpiry).toBe(false);
    expect(draft.tlsExpiryDays).toBe("14");
    expect(draft.recordType).toBe("A");
    expect(draft.auth).toBe("none");
    expect(draft.headers).toEqual([]);
    expect(draft.storedAuth).toBe(undefined);
  });

  test("offers intervals from 20 seconds to 24 hours in order, the default among them", () => {
    expect(intervalChoicesMs[0]).toBe(20_000);
    expect(intervalChoicesMs.at(-1)).toBe(86_400_000);
    expect(intervalChoicesMs).toContain(60_000);
    expect(intervalChoicesMs).toEqual(
      [...intervalChoicesMs].sort((a, b) => a - b)
    );
  });

  test("a fresh assertion row has its kind's starting values", () => {
    expect(newAssertion("status", "k1")).toMatchObject({
      codes: "2xx",
      key: "k1",
      kind: "status",
    });
    expect(newAssertion("body_contains", "k2")).toMatchObject({
      key: "k2",
      kind: "body_contains",
      text: "",
    });
  });
});

describe("a database monitor's fields", () => {
  const url = "postgres://watcher:s3cret@db.example.test/app";
  const postgresFields: MonitorFields = {
    ...tcpFields,
    config: {
      address: "db.example.test:5432",
      expected: "ok",
      query: "SELECT status FROM health",
      type: "postgres",
    },
    name: "قاعدة الطلبات",
  };
  const database = (fields: Partial<MonitorDraft>): MonitorDraft =>
    typed({ connectionUrl: url, type: "postgres", ...fields });

  test("a new Postgres monitor posts its connection URL as a credential and nothing else of it", () => {
    const parsed = inputOf(database({}));
    expect(parsed.ok && parsed.input.config).toEqual({ type: "postgres" });
    expect(parsed.ok && parsed.input.credentials).toEqual({
      headers: [],
      url,
    });
  });

  test("the query and the expected value are posted trimmed, and left out when empty", () => {
    const parsed = inputOf(
      database({ answerExpected: " 1 ", query: "  SELECT 1  " })
    );
    expect(parsed.ok && parsed.input.config).toEqual({
      expected: "1",
      query: "SELECT 1",
      type: "postgres",
    });
  });

  test("HTTP credentials typed before switching to a database are never posted", () => {
    const parsed = inputOf(
      database({
        auth: "bearer",
        connectionUrl: "redis://cache.example.test",
        token: "abc",
        type: "redis",
      })
    );
    expect(parsed.ok && parsed.input.credentials).toEqual({
      headers: [],
      url: "redis://cache.example.test",
    });
  });

  test("a new database monitor without a connection URL is refused on that field", () => {
    expect(
      errorsOf(database({ connectionUrl: "  " }))["credentials.url"]?.id
    ).toBe("monitor_error_required");
  });

  test("a URL another check type reads is refused with the schemes this one takes", () => {
    const cases = [
      ["postgres", "monitor_error_connection_url_postgres"],
      ["mysql", "monitor_error_connection_url_mysql"],
      ["redis", "monitor_error_connection_url_redis"],
    ] as const;
    for (const [type, id] of cases) {
      const wrong = type === "postgres" ? "mysql://db.example.test" : url;
      expect(
        errorsOf(database({ connectionUrl: wrong, type }))["credentials.url"]
          ?.id
      ).toBe(id);
    }
  });

  test("a URL longer than a connection URL may be is refused as too long, not as another scheme", () => {
    const long = `postgres://db.example.test/${"x".repeat(2100)}`;
    expect(
      errorsOf(database({ connectionUrl: long }))["credentials.url"]
    ).toEqual({ id: "monitor_error_too_long", values: { max: 2048 } });
  });

  test("an edit reads the query and the expected value, never the URL, and an empty URL keeps the stored one", () => {
    const draft = draftOf(monitorOf(postgresFields), {
      ...noCredentials,
      url: true,
    });
    expect(draft).toMatchObject({
      answerExpected: "ok",
      connectionUrl: "",
      query: "SELECT status FROM health",
      storedUrlType: "postgres",
      type: "postgres",
    });
    const parsed = inputOf(draft);
    expect(parsed.ok && parsed.input.credentials).toBe(undefined);
    // The address is the server's to write from the URL, never posted back.
    expect(parsed.ok && parsed.input.config).toEqual({
      expected: "ok",
      query: "SELECT status FROM health",
      type: "postgres",
    });
  });

  test("an edit that switches to another database asks for a URL, since the stored one is not that type's", () => {
    const draft = draftOf(monitorOf(postgresFields), {
      ...noCredentials,
      url: true,
    });
    const switched = withField(draft, "type", "mysql");
    expect(errorsOf(switched)["credentials.url"]?.id).toBe(
      "monitor_error_required"
    );
  });

  test("an edit with no URL stored, as one the install key cannot open, asks for it", () => {
    const draft = draftOf(monitorOf(postgresFields), noCredentials);
    expect(draft.storedUrlType).toBe(undefined);
    expect(errorsOf(draft)["credentials.url"]?.id).toBe(
      "monitor_error_required"
    );
  });

  test("a duplicate asks for the URL again", () => {
    const draft = copyDraftOf(monitorOf(postgresFields), "نسخة");
    expect(draft.storedUrlType).toBe(undefined);
    expect(draft.query).toBe("SELECT status FROM health");
    expect(errorsOf(draft)["credentials.url"]?.id).toBe(
      "monitor_error_required"
    );
  });

  test("choosing a database starts at Postgres and keeps the database already chosen; a database is chosen by its own type", () => {
    const http = draftOf(undefined, noCredentials);
    expect(withField(http, "type", "database").type).toBe("postgres");
    const redis = withField(http, "type", "redis");
    expect(redis.type).toBe("redis");
    expect(withField(redis, "type", "database").type).toBe("redis");
    expect(withField(redis, "type", "tcp").type).toBe("tcp");
  });
});

describe("a Docker monitor's fields", () => {
  const dockerFields: MonitorFields = {
    ...tcpFields,
    config: {
      container: "orders-api",
      endpoint: "http://socket-proxy:2375",
      type: "docker",
    },
    name: "واجهة الطلبات",
  };

  test("a new monitor's draft reaches the local Docker socket and names no container yet", () => {
    const draft = draftOf(undefined, noCredentials);
    expect(draft.dockerEndpoint).toBe("/var/run/docker.sock");
    expect(draft.container).toBe("");
  });

  test("a stored Docker monitor round-trips through the draft with no credentials", () => {
    const parsed = inputOf(draftOf(monitorOf(dockerFields), noCredentials));
    expect(parsed.ok && parsed.input.config).toEqual(dockerFields.config);
    expect(parsed.ok && parsed.input.credentials).toBe(undefined);
  });

  test("the Docker choice of the check type control picks the docker check type", () => {
    const draft = withField(typed({}), "type", "docker");
    expect(draft.type).toBe("docker");
    expect(
      withField(
        withField(draft, "container", "web"),
        "dockerEndpoint",
        "/run/podman/podman.sock"
      )
    ).toMatchObject({
      container: "web",
      dockerEndpoint: "/run/podman/podman.sock",
    });
  });

  test("a container left empty is required, and one Docker would refuse names the rule", () => {
    const empty = errorsOf(typed({ type: "docker" }));
    expect(empty["config.container"]?.id).toBe("monitor_error_required");
    const slash = errorsOf(typed({ container: "/web", type: "docker" }));
    expect(slash["config.container"]?.id).toBe("monitor_error_container");
  });

  test("an endpoint that is neither a socket's path nor a plain URL names the rule, and an empty one is required", () => {
    const tcp = errorsOf(
      typed({
        container: "web",
        dockerEndpoint: "tcp://192.0.2.10:2375",
        type: "docker",
      })
    );
    expect(tcp["config.endpoint"]?.id).toBe("monitor_error_docker_endpoint");
    const blank = errorsOf(
      typed({ container: "web", dockerEndpoint: " ", type: "docker" })
    );
    expect(blank["config.endpoint"]?.id).toBe("monitor_error_required");
  });
});

describe("every field round-trips through the draft and the Zod schema", () => {
  for (const [name, fields] of [
    ["HTTP", httpFields],
    ["TCP", tcpFields],
    ["DNS", dnsFields],
  ] as const) {
    test(`${name}: the draft of a stored monitor posts its fields unchanged`, () => {
      const parsed = inputOf(draftOf(monitorOf(fields), noCredentials));
      if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.errors));
      }
      const { credentials, ...rest } = parsed.input;
      expect(rest).toEqual(fields);
      expect(credentials).toBe(undefined);
    });
  }

  test("an interval the list does not offer is kept as stored", () => {
    const parsed = inputOf(
      draftOf(monitorOf({ ...tcpFields, intervalMs: 45_000 }), noCredentials)
    );
    expect(parsed.ok && parsed.input.intervalMs).toBe(45_000);
  });

  test("stored credentials come back as names with every secret left out, which the server keeps", () => {
    const view: CredentialsView = {
      auth: { kind: "basic", user: "ops" },
      headers: [{ name: "X-Api-Key" }],
      url: false,
    };
    const draft = draftOf(monitorOf(httpFields), view);
    expect(draft.auth).toBe("basic");
    expect(draft.user).toBe("ops");
    expect(draft.password).toBe("");
    expect(draft.storedAuth).toBe("basic");
    expect(
      draft.headers.map((row) => [row.name, row.value, row.storedName])
    ).toEqual([["X-Api-Key", "", "X-Api-Key"]]);
    const parsed = inputOf(draft);
    expect(parsed.ok && parsed.input.credentials).toEqual({
      auth: { kind: "basic", user: "ops" },
      headers: [{ name: "X-Api-Key" }],
    });
  });

  test("a stored bearer token is kept when its field stays empty and replaced when typed", () => {
    const view: CredentialsView = {
      auth: { kind: "bearer" },
      headers: [],
      url: false,
    };
    const draft = draftOf(monitorOf(httpFields), view);
    const kept = inputOf(draft);
    expect(kept.ok && kept.input.credentials).toEqual({
      auth: { kind: "bearer" },
      headers: [],
    });
    const replaced = inputOf({ ...draft, token: "new-token" });
    expect(replaced.ok && replaced.input.credentials?.auth).toEqual({
      kind: "bearer",
      token: "new-token",
    });
  });
});

describe("the form's units and text fields", () => {
  test("the timeout is typed in seconds and posted in milliseconds", () => {
    const parsed = inputOf(typed({ timeoutSeconds: "30" }));
    expect(parsed.ok && parsed.input.timeoutMs).toBe(30_000);
  });

  test("an empty threshold, retention, group or description is absent", () => {
    const parsed = inputOf(
      typed({ degradedMs: "", description: " ", group: "", retentionDays: "" })
    );
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.errors));
    }
    expect(parsed.input.degradedMs).toBe(undefined);
    expect(parsed.input.retentionDays).toBe(undefined);
    expect(parsed.input.group).toBe(undefined);
    expect(parsed.input.description).toBe(undefined);
  });

  test("the certificate expiry option off posts no day count, on posts the days", () => {
    const off = inputOf(typed({ tlsExpiry: false, tlsExpiryDays: "30" }));
    expect(off.ok && off.input.config.type).toBe("http");
    expect(off.ok && off.input.config).not.toHaveProperty("tlsExpiryDays");
    const on = inputOf(typed({ tlsExpiry: true, tlsExpiryDays: "30" }));
    expect(on.ok && on.input.config).toMatchObject({ tlsExpiryDays: 30 });
  });

  test("tags are split on Latin and Arabic commas, trimmed, each once", () => {
    expect(tagsOf("ويب، عام , api,, ويب")).toEqual(["ويب", "عام", "api"]);
    expect(tagsOf("  ")).toEqual([]);
  });

  test("only the chosen check type's fields are posted, and what the other types hold is kept in the draft", () => {
    const draft = typed({ host: "db.example.test", port: "5432", type: "tcp" });
    const parsed = inputOf(draft);
    expect(parsed.ok && parsed.input.config).toEqual({
      host: "db.example.test",
      port: 5432,
      type: "tcp",
    });
    expect(draft.url).toBe("https://example.test/");
  });

  test("a new password or header value is posted as typed, even empty, since nothing is stored to keep", () => {
    const parsed = inputOf(
      typed({
        auth: "basic",
        headers: [
          { key: "h1", name: "X-Empty", storedName: undefined, value: "" },
        ],
        password: "",
        user: "ops",
      })
    );
    expect(parsed.ok && parsed.input.credentials).toEqual({
      auth: { kind: "basic", password: "", user: "ops" },
      headers: [{ name: "X-Empty", value: "" }],
    });
  });

  test("auth none posts no auth, whatever the fields still hold", () => {
    const parsed = inputOf(typed({ auth: "none", token: "t", user: "ops" }));
    expect(parsed.ok && parsed.input.credentials).toBe(undefined);
  });
});

describe("a refused field is named with its catalog message", () => {
  test("an empty name and an empty address are required", () => {
    const errors = errorsOf(typed({ name: " ", url: "" }));
    expect(errors.name?.id).toBe("monitor_error_required");
    expect(errors["config.url"]?.id).toBe("monitor_error_required");
  });

  test("a name longer than its limit names the limit", () => {
    expect(errorsOf(typed({ name: "x".repeat(121) })).name).toEqual({
      id: "monitor_error_too_long",
      values: { max: 120 },
    });
  });

  test("an address that is not http or https, or that carries a user name, is refused with its own message", () => {
    expect(
      errorsOf(typed({ url: "ftp://example.test/" }))["config.url"]?.id
    ).toBe("monitor_error_url");
    expect(
      errorsOf(typed({ url: "https://ops:secret@example.test/" }))["config.url"]
        ?.id
    ).toBe("monitor_error_url_credentials");
  });

  test("a DNS name that is no domain name is refused with its own message, not the host's", () => {
    expect(
      errorsOf(typed({ dnsName: "bad name", type: "dns" }))["config.name"]?.id
    ).toBe("monitor_error_dns_name");
  });

  test("a TCP host that is no host name and a port out of range or not a number", () => {
    expect(
      errorsOf(typed({ host: "bad host", port: "22", type: "tcp" }))[
        "config.host"
      ]?.id
    ).toBe("monitor_error_host");
    expect(
      errorsOf(typed({ host: "db", port: "70000", type: "tcp" }))["config.port"]
    ).toEqual({ id: "monitor_error_range", values: { max: 65_535, min: 1 } });
    expect(
      errorsOf(typed({ host: "db", port: "abc", type: "tcp" }))["config.port"]
        ?.id
    ).toBe("monitor_error_whole_number");
  });

  test("a DNS name that is no host name and a resolver that is no IP address", () => {
    const errors = errorsOf(
      typed({ dnsName: "", resolver: "dns.example.test", type: "dns" })
    );
    expect(errors["config.name"]?.id).toBe("monitor_error_required");
    expect(errors["config.resolver"]?.id).toBe("monitor_error_resolver");
  });

  test("the schedule's ranges are worded in the form's units: seconds for the timeout", () => {
    expect(errorsOf(typed({ timeoutSeconds: "90" })).timeoutMs).toEqual({
      id: "monitor_error_range",
      values: { max: 60, min: 1 },
    });
    expect(errorsOf(typed({ retries: "11" })).retries).toEqual({
      id: "monitor_error_range",
      values: { max: 10, min: 0 },
    });
    expect(errorsOf(typed({ degradedMs: "70000" })).degradedMs).toEqual({
      id: "monitor_error_range",
      values: { max: 60_000, min: 1 },
    });
    expect(
      errorsOf(typed({ ownRetention: true, retentionDays: "0" })).retentionDays
    ).toEqual({
      id: "monitor_error_range",
      values: { max: 3650, min: 1 },
    });
    expect(errorsOf(typed({ timeoutSeconds: "0.5" })).timeoutMs).toEqual({
      id: "monitor_error_range",
      values: { max: 60, min: 1 },
    });
  });

  test("an assertion's status set and pattern are refused on their own row", () => {
    const errors = errorsOf(
      typed({
        assertions: [
          { ...newAssertion("status", "a"), codes: "2xx, abc" },
          { ...newAssertion("json_matches", "b"), path: "v", pattern: "(" },
          { ...newAssertion("response_time_under", "c"), ms: "0" },
        ],
      })
    );
    expect(errors["config.assertions.0.codes"]?.id).toBe(
      "monitor_error_status_codes"
    );
    expect(errors["config.assertions.1.pattern"]?.id).toBe(
      "monitor_error_pattern"
    );
    expect(errors["config.assertions.2.ms"]).toEqual({
      id: "monitor_error_range",
      values: { max: 60_000, min: 1 },
    });
  });

  test("a JSON path the check cannot read is refused on its row with a message that names the grammar", () => {
    const errors = errorsOf(
      typed({
        assertions: [
          { ...newAssertion("json_equals", "a"), path: "data..items" },
          {
            ...newAssertion("json_matches", "b"),
            path: "data.*",
            pattern: ".",
          },
        ],
      })
    );
    expect(errors["config.assertions.0.path"]).toEqual({
      id: "monitor_error_json_path",
    });
    expect(errors["config.assertions.1.path"]).toEqual({
      id: "monitor_error_json_path",
    });
  });

  test("a JSON path the check cannot read is refused beside an empty field elsewhere, not after it is filled", () => {
    const errors = errorsOf(
      typed({
        assertions: [
          { ...newAssertion("json_equals", "a"), path: "data..items" },
        ],
        retries: "",
      })
    );
    expect(errors.retries).toEqual({ id: "monitor_error_required" });
    expect(errors["config.assertions.0.path"]).toEqual({
      id: "monitor_error_json_path",
    });
  });

  test("a JSON path the check cannot read is refused beside a blank assertion in the same list", () => {
    const errors = errorsOf(
      typed({
        assertions: [
          { ...newAssertion("response_time_under", "a"), ms: "" },
          { ...newAssertion("json_equals", "b"), path: "data..items" },
        ],
      })
    );
    expect(errors["config.assertions.0.ms"]).toEqual({
      id: "monitor_error_required",
    });
    expect(errors["config.assertions.1.path"]).toEqual({
      id: "monitor_error_json_path",
    });
  });

  test("a header name, a repeated header and a user name with a colon are refused where they were typed", () => {
    const errors = errorsOf(
      typed({
        auth: "basic",
        headers: [
          { key: "a", name: "X Bad", storedName: undefined, value: "v" },
          { key: "b", name: "X-Key", storedName: undefined, value: "v" },
          { key: "c", name: "x-key", storedName: undefined, value: "v" },
          { key: "d", name: "X-Line", storedName: undefined, value: "a\nb" },
        ],
        password: "p",
        user: "a:b",
      })
    );
    expect(errors["credentials.headers.0.name"]?.id).toBe(
      "monitor_error_header_name"
    );
    expect(errors["credentials.headers.2.name"]?.id).toBe(
      "monitor_error_header_duplicate"
    );
    expect(errors["credentials.headers.3.value"]?.id).toBe(
      "monitor_error_header_value"
    );
    expect(errors["credentials.auth.user"]?.id).toBe("monitor_error_user");
  });

  test("a minus sign in Arabic-Indic digits, or before zero, is still refused by the range", () => {
    expect(errorsOf(typed({ degradedMs: "-٥" })).degradedMs).toEqual({
      id: "monitor_error_range",
      values: { max: 60_000, min: 1 },
    });
    expect(errorsOf(typed({ degradedMs: "-0" })).degradedMs).toEqual({
      id: "monitor_error_range",
      values: { max: 60_000, min: 1 },
    });
  });

  test("a sign out of place, a doubled one or a negative fraction is still not a whole number", () => {
    for (const degradedMs of ["5-", "--5", "-1.5", "-"]) {
      expect(errorsOf(typed({ degradedMs })).degradedMs).toEqual({
        id: "monitor_error_whole_number",
      });
    }
    expect(errorsOf(typed({ timeoutSeconds: "--5" })).timeoutMs).toEqual({
      id: "monitor_error_number",
    });
  });

  test("a negative number is refused by the range it breaks, not as a number that is not whole", () => {
    expect(errorsOf(typed({ degradedMs: "-5" })).degradedMs).toEqual({
      id: "monitor_error_range",
      values: { max: 60_000, min: 1 },
    });
    expect(errorsOf(typed({ retries: "-1" })).retries).toEqual({
      id: "monitor_error_range",
      values: { max: 10, min: 0 },
    });
    expect(errorsOf(typed({ timeoutSeconds: "-5" })).timeoutMs).toEqual({
      id: "monitor_error_range",
      values: { max: 60, min: 1 },
    });
    expect(
      errorsOf(typed({ ownRetention: true, retentionDays: "-30" }))
        .retentionDays
    ).toEqual({ id: "monitor_error_range", values: { max: 3650, min: 1 } });
    expect(
      errorsOf(typed({ tlsExpiry: true, tlsExpiryDays: "-7" }))[
        "config.tlsExpiryDays"
      ]
    ).toEqual({ id: "monitor_error_range", values: { max: 365, min: 1 } });
    expect(
      errorsOf(typed({ host: "db", port: "-22", type: "tcp" }))["config.port"]
    ).toEqual({ id: "monitor_error_range", values: { max: 65_535, min: 1 } });
    expect(
      errorsOf(
        typed({
          assertions: [
            { ...newAssertion("response_time_under", "a"), ms: "-100" },
          ],
        })
      )["config.assertions.0.ms"]
    ).toEqual({ id: "monitor_error_range", values: { max: 60_000, min: 1 } });
  });

  test("a bearer token is required unless one is stored", () => {
    expect(
      errorsOf(typed({ auth: "bearer", token: "" }))["credentials.auth.token"]
        ?.id
    ).toBe("monitor_error_required");
    const kept = inputOf(
      typed({ auth: "bearer", storedAuth: "bearer", token: "" })
    );
    expect(kept.ok && kept.input.credentials?.auth).toEqual({ kind: "bearer" });
  });

  test("more tags than allowed names the limit", () => {
    const tags = Array.from({ length: 21 }, (_, index) => `t${index}`).join(
      ","
    );
    expect(errorsOf(typed({ tags })).tags).toEqual({
      id: "monitor_error_too_many",
      values: { max: 20 },
    });
  });
});

describe("what capture always costs", () => {
  test("is about 5.8 MB a day at 60 seconds and scales with the interval", () => {
    expect(captureBytesPerDay(60_000)).toBe(5_800_000);
    expect(captureBytesPerDay(30_000)).toBe(11_600_000);
    expect(captureBytesPerDay(3_600_000)).toBe(96_667);
  });
});

describe("each assertion's state in a test", () => {
  const assertions =
    httpFields.config.type === "http"
      ? httpFields.config.assertions.slice(0, 3)
      : [];
  const test_ = (overrides: Partial<MonitorTest>): MonitorTest => ({
    bytes: 2,
    failure: undefined,
    reason: "ok",
    response: undefined,
    responseMs: 10,
    result: "up",
    statusCode: 200,
    ...overrides,
  });

  test("every assertion passed on an up or degraded check", () => {
    expect(assertionStates(assertions, test_({}))).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(assertionStates(assertions, test_({ result: "degraded" }))).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
  });

  test("the ones before the failed assertion passed and the ones after were never evaluated", () => {
    const [, failed] = assertions;
    expect(
      assertionStates(
        assertions,
        test_({
          failure: {
            assertion: failed,
            error: undefined,
            params: {
              expected: "error",
              observed: "an error page",
              reason: "assertion_failed",
            },
          },
          reason: "assertion_failed",
          result: "down",
        })
      )
    ).toEqual(["passed", "failed", "unreached"]);
  });

  test("a check that got no response evaluated none", () => {
    expect(
      assertionStates(
        assertions,
        test_({
          failure: {
            assertion: undefined,
            error: undefined,
            params: { reason: "timeout", timeoutMs: 10_000 },
          },
          reason: "timeout",
          result: "down",
          statusCode: undefined,
        })
      )
    ).toEqual(["unreached", "unreached", "unreached"]);
  });
});

describe("an input changes the draft field it names", () => {
  const draft = typed({});

  test("a text field takes what was typed", () => {
    expect(withField(draft, "url", "https://x.test/").url).toBe(
      "https://x.test/"
    );
    expect(withField(draft, "timeoutSeconds", "30").timeoutSeconds).toBe("30");
  });

  test("a row field is named by its row: assertions.1.text changes the second row only", () => {
    const two = {
      ...draft,
      assertions: [...draft.assertions, newAssertion("body_contains", "k2")],
    };
    const changed = withField(two, "assertions.1.text", "ok");
    expect(changed.assertions.map((row) => row.text)).toEqual(["", "ok"]);
    expect(
      withField(changed, "assertions.1.kind", "json_equals").assertions[1]?.kind
    ).toBe("json_equals");
    const header = withField(
      {
        ...draft,
        headers: [{ key: "h", name: "", storedName: undefined, value: "" }],
      },
      "headers.0.name",
      "X-Key"
    );
    expect(header.headers[0]?.name).toBe("X-Key");
  });

  test("a choice the form does not offer, or a name it does not have, changes nothing", () => {
    expect(withField(draft, "method", "TRACE")).toBe(draft);
    expect(withField(draft, "type", "ping")).toBe(draft);
    expect(withField(draft, "assertions.0.kind", "regex")).toBe(draft);
    expect(withField(draft, "assertions.0.key", "x")).toBe(draft);
    expect(withField(draft, "storedAuth", "basic")).toBe(draft);
    expect(withField(draft, "nothing", "x")).toBe(draft);
  });

  test("a choice the form offers is taken, and an interval is a number of milliseconds", () => {
    expect(withField(draft, "method", "POST").method).toBe("POST");
    expect(withField(draft, "auth", "bearer").auth).toBe("bearer");
    expect(withField(draft, "captureMode", "always").captureMode).toBe(
      "always"
    );
    expect(withField(draft, "intervalMs", "45000").intervalMs).toBe(45_000);
  });
});

describe("edge cases of the posted input", () => {
  test("the certificate expiry option posts no day count for an http address, which has no certificate", () => {
    const parsed = inputOf(
      typed({ tlsExpiry: true, tlsExpiryDays: "30", url: "http://x.test/" })
    );
    expect(parsed.ok && parsed.input.config.type).toBe("http");
    expect(parsed.ok && parsed.input.config).not.toHaveProperty(
      "tlsExpiryDays"
    );
  });

  test("numbers typed in Arabic-Indic digits are read as the same numbers", () => {
    const parsed = inputOf(
      typed({
        ownRetention: true,
        retentionDays: "۳۰",
        retries: "٣",
        timeoutSeconds: "١٥",
      })
    );
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.errors));
    }
    expect(parsed.input.retries).toBe(3);
    expect(parsed.input.timeoutMs).toBe(15_000);
    expect(parsed.input.retentionDays).toBe(30);
  });

  test("more headers than allowed names the limit on the headers", () => {
    const headers = Array.from({ length: 21 }, (_, index) => ({
      key: `h${index}`,
      name: `X-H${index}`,
      storedName: undefined,
      value: "v",
    }));
    expect(errorsOf(typed({ headers }))["credentials.headers"]).toEqual({
      id: "monitor_error_too_many",
      values: { max: 20 },
    });
  });
});

describe("edge cases of the posted credentials, timeout and header names", () => {
  test("a TCP or DNS monitor posts no credentials, whatever the HTTP fields still hold", () => {
    const withSecrets = typed({
      auth: "bearer",
      headers: [{ key: "h", name: "X-A", storedName: undefined, value: "v" }],
      token: "abc",
    });
    const tcp = inputOf({
      ...withSecrets,
      host: "db",
      port: "5432",
      type: "tcp",
    });
    expect(tcp.ok && tcp.input.credentials).toBe(undefined);
    const dns = inputOf({
      ...withSecrets,
      dnsName: "example.test",
      type: "dns",
    });
    expect(dns.ok && dns.input.credentials).toBe(undefined);
  });

  test("a stored timeout that is not whole seconds round-trips, and the timeout takes a decimal number of seconds", () => {
    const parsed = inputOf(
      draftOf(monitorOf({ ...tcpFields, timeoutMs: 2500 }), noCredentials)
    );
    expect(parsed.ok && parsed.input.timeoutMs).toBe(2500);
    const typedDecimal = inputOf(typed({ timeoutSeconds: "1.5" }));
    expect(typedDecimal.ok && typedDecimal.input.timeoutMs).toBe(1500);
    const arabicDecimal = inputOf(typed({ timeoutSeconds: "٢٫٥" }));
    expect(arabicDecimal.ok && arabicDecimal.input.timeoutMs).toBe(2500);
    expect(errorsOf(typed({ timeoutSeconds: "abc" })).timeoutMs?.id).toBe(
      "monitor_error_number"
    );
  });

  test("a stored header renamed with its value left empty asks for the value, since the kept one belongs to the old name", () => {
    const draft = draftOf(monitorOf(httpFields), {
      auth: undefined,
      headers: [{ name: "X-Api-Key" }],
      url: false,
    });
    const renamed = withField(draft, "headers.0.name", "X-Other");
    expect(errorsOf(renamed)["credentials.headers.0.value"]?.id).toBe(
      "monitor_error_required"
    );
    const recased = inputOf(withField(draft, "headers.0.name", "x-api-key"));
    expect(recased.ok && recased.input.credentials?.headers).toEqual([
      { name: "x-api-key", value: undefined },
    ]);
  });

  test("a bearer token outside Latin-1 is refused on the token field", () => {
    expect(
      errorsOf(typed({ auth: "bearer", token: "رمز" }))[
        "credentials.auth.token"
      ]?.id
    ).toBe("monitor_error_token");
  });
});

describe("edge cases of the posted basic user name and status set", () => {
  test("a basic user name of spaces only is required", () => {
    expect(
      errorsOf(typed({ auth: "basic", password: "p", user: "   " }))[
        "credentials.auth.user"
      ]?.id
    ).toBe("monitor_error_required");
  });

  test("a status set is split on Latin and Arabic commas, as the tags are", () => {
    const parsed = inputOf(
      typed({
        assertions: [{ ...newAssertion("status", "a"), codes: "2xx، 301" }],
      })
    );
    expect(parsed.ok && parsed.input.config).toMatchObject({
      assertions: [{ codes: ["2xx", "301"], kind: "status" }],
    });
  });
});

describe("a monitor's own retention in the draft", () => {
  test("the install default posts no retention and keeps the days typed for the monitor's own, which a switch back posts", () => {
    const own = typed({ ownRetention: true, retentionDays: "30" });
    const parsedOwn = inputOf(own);
    expect(parsedOwn.ok && parsedOwn.input.retentionDays).toBe(30);
    const followed = inputOf({ ...own, ownRetention: false });
    expect(followed.ok && followed.input.retentionDays).toBe(undefined);
    expect({ ...own, ownRetention: false }.retentionDays).toBe("30");
    expect(
      inputOf({ ...own, ownRetention: false, retentionDays: "0" }).ok
    ).toBe(true);
  });

  test("a stored monitor with its own retention opens with it chosen, one without opens on the default", () => {
    expect(draftOf(monitorOf(httpFields), noCredentials).ownRetention).toBe(
      true
    );
    expect(draftOf(monitorOf(tcpFields), noCredentials).ownRetention).toBe(
      false
    );
  });
});

const heartbeatFields: MonitorFields = {
  config: {
    graceMs: 900_000,
    schedule: { everyMs: 7_200_000, kind: "every" },
    type: "heartbeat",
  },
  description: "نسخة قاعدة البيانات",
  group: "الإنتاج",
  intervalMs: 60_000,
  name: "النسخ الاحتياطي",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: ["ليلي"],
  timeoutMs: 10_000,
};

const cronFields: MonitorFields = {
  ...heartbeatFields,
  config: {
    schedule: { expression: "30 2 * * *", kind: "cron" },
    type: "heartbeat",
  },
};

/** A new heartbeat monitor's draft with some fields typed. */
const beating = (fields: Partial<MonitorDraft>): MonitorDraft =>
  typed({ type: "heartbeat", ...fields });

describe("a duplicate's draft", () => {
  const notified: Partial<MonitorFields> = {
    channels: ["c1", "c2"],
    events: ["down", "recovered"],
    reminderMs: 600_000,
  };
  for (const [name, fields] of [
    ["HTTP", httpFields],
    ["TCP", tcpFields],
    ["DNS", dnsFields],
    ["heartbeat", heartbeatFields],
    ["cron heartbeat", cronFields],
  ] as const) {
    test(`${name}: a duplicate posts every field of the original under its new name, and no credentials`, () => {
      const original = monitorOf({ ...fields, ...notified });
      const parsed = inputOf(copyDraftOf(original, "نسخة من الأصل"));
      if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.errors));
      }
      const { credentials, ...rest } = parsed.input;
      expect(rest).toEqual({
        ...fields,
        ...notified,
        name: "نسخة من الأصل",
      });
      expect(credentials).toBe(undefined);
    });
  }

  test("a duplicate keeps no stored secret and asks for no new heartbeat URL", () => {
    const draft = copyDraftOf(monitorOf(heartbeatFields), "نسخة");
    expect(draft.storedAuth).toBe(undefined);
    expect(draft.headers).toEqual([]);
    expect(draft.renewHeartbeatUrl).toBe(false);
  });
});

describe("a heartbeat monitor's fields", () => {
  test("the form offers heartbeat among the check types, and a new heartbeat expects one every hour with the default grace", () => {
    const draft = withField(
      draftOf(undefined, noCredentials),
      "type",
      "heartbeat"
    );
    expect(draft.type).toBe("heartbeat");
    expect(draft.scheduleKind).toBe("every");
    expect([draft.every, draft.everyUnit]).toEqual(["1", "hours"]);
    expect(draft.grace).toBe("");
    expect(draft.cron).toBe("");
    expect(draft.renewHeartbeatUrl).toBe(false);
  });

  for (const [name, fields] of [
    ["every N", heartbeatFields],
    ["cron", cronFields],
  ] as const) {
    test(`${name}: the draft of a stored heartbeat monitor posts its fields unchanged`, () => {
      const parsed = inputOf(draftOf(monitorOf(fields), noCredentials));
      if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.errors));
      }
      const { credentials, ...rest } = parsed.input;
      expect(rest).toEqual(fields);
      expect(credentials).toBe(undefined);
    });
  }

  test("a stored period and grace open in the largest unit that holds them whole", () => {
    const draft = draftOf(monitorOf(heartbeatFields), noCredentials);
    expect([draft.every, draft.everyUnit]).toEqual(["2", "hours"]);
    expect([draft.grace, draft.graceUnit]).toEqual(["15", "minutes"]);
    expect(durationDraft(90_000)).toEqual({ amount: "90", unit: "seconds" });
    expect(durationDraft(5_400_000)).toEqual({ amount: "90", unit: "minutes" });
    expect(durationDraft(3 * 86_400_000)).toEqual({
      amount: "3",
      unit: "days",
    });
  });

  test("the period is posted in milliseconds from its unit, and an empty grace posts none", () => {
    const parsed = inputOf(
      beating({ every: "3", everyUnit: "days", grace: "" })
    );
    expect(parsed.ok && parsed.input.config).toEqual({
      schedule: { everyMs: 3 * 86_400_000, kind: "every" },
      type: "heartbeat",
    });
    const graced = inputOf(
      beating({
        every: "45",
        everyUnit: "seconds",
        grace: "2",
        graceUnit: "hours",
      })
    );
    expect(graced.ok && graced.input.config).toEqual({
      graceMs: 7_200_000,
      schedule: { everyMs: 45_000, kind: "every" },
      type: "heartbeat",
    });
  });

  test("the cron choice posts the expression, trimmed, and not the period", () => {
    const parsed = inputOf(
      beating({ cron: " 0 3 * * * ", every: "", scheduleKind: "cron" })
    );
    expect(parsed.ok && parsed.input.config).toEqual({
      schedule: { expression: "0 3 * * *", kind: "cron" },
      type: "heartbeat",
    });
  });

  test("a heartbeat monitor posts the default interval, timeout and retries and no threshold or credentials, whatever the other types' fields hold", () => {
    const parsed = inputOf(
      beating({
        auth: "bearer",
        degradedMs: "400",
        intervalMs: 300_000,
        retries: "7",
        timeoutSeconds: "30",
        token: "secret",
      })
    );
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.errors));
    }
    expect(parsed.input).toMatchObject({
      intervalMs: 60_000,
      retries: 2,
      timeoutMs: 10_000,
    });
    expect(parsed.input.degradedMs).toBe(undefined);
    expect(parsed.input.credentials).toBe(undefined);
  });

  test("a period outside 20 seconds to 30 days, or not a whole number, is refused on the period", () => {
    expect(errorsOf(beating({ every: "10", everyUnit: "seconds" }))).toEqual({
      "config.schedule.everyMs": { id: "monitor_error_period" },
    });
    expect(errorsOf(beating({ every: "31", everyUnit: "days" }))).toEqual({
      "config.schedule.everyMs": { id: "monitor_error_period" },
    });
    expect(errorsOf(beating({ every: "1.5" }))).toEqual({
      "config.schedule.everyMs": { id: "monitor_error_whole_number" },
    });
    expect(errorsOf(beating({ every: "" }))).toEqual({
      "config.schedule.everyMs": { id: "monitor_error_required" },
    });
  });

  test("a grace period longer than 30 days, or zero, is refused on the grace period", () => {
    expect(errorsOf(beating({ grace: "31", graceUnit: "days" }))).toEqual({
      "config.graceMs": { id: "monitor_error_grace" },
    });
    expect(errorsOf(beating({ grace: "0" }))).toEqual({
      "config.graceMs": { id: "monitor_error_grace" },
    });
  });

  test("a negative period or grace period is refused by its range, not as a number that is not whole", () => {
    expect(errorsOf(beating({ every: "-5" }))).toEqual({
      "config.schedule.everyMs": { id: "monitor_error_period" },
    });
    expect(errorsOf(beating({ grace: "-5" }))).toEqual({
      "config.graceMs": { id: "monitor_error_grace" },
    });
  });

  test("an empty cron expression is required and one Bun's grammar does not read is refused with its own message", () => {
    expect(errorsOf(beating({ cron: "", scheduleKind: "cron" }))).toEqual({
      "config.schedule.expression": { id: "monitor_error_required" },
    });
    expect(
      errorsOf(beating({ cron: "every night", scheduleKind: "cron" }))
    ).toEqual({ "config.schedule.expression": { id: "monitor_error_cron" } });
  });

  test("a cron expression Bun cannot read, or one that never fires, is refused on its field before the server sees it", () => {
    for (const cron of ["*/128 * * * *", "0 0 30 2 *"]) {
      expect(errorsOf(beating({ cron, scheduleKind: "cron" }))).toEqual({
        "config.schedule.expression": { id: "monitor_error_cron" },
      });
    }
  });

  test("the schedule's choices and units are taken by name, and one the form does not have changes nothing", () => {
    const draft = beating({});
    expect(withField(draft, "scheduleKind", "cron").scheduleKind).toBe("cron");
    expect(withField(draft, "everyUnit", "days").everyUnit).toBe("days");
    expect(withField(draft, "graceUnit", "seconds").graceUnit).toBe("seconds");
    expect(withField(draft, "cron", "@daily").cron).toBe("@daily");
    expect(withField(draft, "every", "5").every).toBe("5");
    expect(withField(draft, "grace", "9").grace).toBe("9");
    expect(withField(draft, "scheduleKind", "sometimes")).toBe(draft);
    expect(withField(draft, "everyUnit", "weeks")).toBe(draft);
  });

  test("a period typed in Arabic-Indic digits is read as the same number", () => {
    const parsed = inputOf(beating({ every: "٣", everyUnit: "hours" }));
    expect(parsed.ok && parsed.input.config).toEqual({
      schedule: { everyMs: 3 * 3_600_000, kind: "every" },
      type: "heartbeat",
    });
  });
});

describe("the line a job runs", () => {
  test("calls the URL with curl, failing on an error status, quiet otherwise, retrying, within ten seconds", () => {
    expect(curlLine("https://status.example.test/api/heartbeat/abc")).toBe(
      "curl -fsS -m 10 --retry 3 -o /dev/null https://status.example.test/api/heartbeat/abc"
    );
  });
});

describe("the channels a monitor selects", () => {
  const choices = [
    { appliesToNew: true, id: "c1", name: "ops", type: "webhook" },
    { appliesToNew: false, id: "c2", name: "night", type: "webhook" },
    { appliesToNew: true, id: "c3", name: "all", type: "webhook" },
  ] as const;

  test("a new monitor starts with the channels that apply to new monitors", () => {
    expect(draftOf(undefined, noCredentials, choices).channels).toEqual([
      "c1",
      "c3",
    ]);
    expect(draftOf(undefined, noCredentials).channels).toEqual([]);
  });

  test("a stored monitor starts with the channels it selects, whatever the flag says", () => {
    const monitor = monitorOf({ ...tcpFields, channels: ["c2"] });
    expect(draftOf(monitor, noCredentials, choices).channels).toEqual(["c2"]);
  });

  test("selecting and clearing a channel keeps the list's order, once each", () => {
    const draft = draftOf(undefined, noCredentials, choices);
    const withNight = withChannel(draft, choices, "c2", true);
    expect(withNight.channels).toEqual(["c1", "c2", "c3"]);
    expect(withChannel(withNight, choices, "c2", true).channels).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(withChannel(withNight, choices, "c1", false).channels).toEqual([
      "c2",
      "c3",
    ]);
    expect(withChannel(draft, choices, "unknown", true).channels).toEqual([
      "c1",
      "c3",
    ]);
  });

  test("the posted input carries the selection", () => {
    const draft = withChannel(
      typed({ url: "https://example.test/" }),
      choices,
      "c2",
      true
    );
    const parsed = inputOf(draft);
    expect(parsed.ok && parsed.input.channels).toEqual(["c2"]);
  });
});

describe("the monitor's events and reminder in the form", () => {
  test("a new monitor's draft has all five events on and the reminder off, ready at one hour", () => {
    const draft = draftOf(undefined, noCredentials);
    expect(draft.events).toEqual([...monitorEventKinds]);
    expect(draft.reminder).toBe(false);
    expect(draft.reminderMs).toBe(3_600_000);
  });

  test("a stored monitor's events and reminder round-trip", () => {
    const fields: MonitorFields = {
      ...tcpFields,
      events: ["down", "recovered"],
      reminderMs: 900_000,
    };
    const draft = draftOf(monitorOf(fields), noCredentials);
    expect(draft.events).toEqual(["down", "recovered"]);
    expect(draft.reminder).toBe(true);
    expect(draft.reminderMs).toBe(900_000);
    const parsed = inputOf(draft);
    expect(parsed.ok && parsed.input.events).toEqual(["down", "recovered"]);
    expect(parsed.ok && parsed.input.reminderMs).toBe(900_000);
  });

  test("the reminder switched off posts no interval, and keeps the one chosen for when it is switched on again", () => {
    const off = typed({ reminder: false, reminderMs: 900_000 });
    const parsed = inputOf(off);
    expect(parsed.ok && parsed.input.reminderMs).toBe(undefined);
    expect(off.reminderMs).toBe(900_000);
    const on = inputOf({ ...off, reminder: true });
    expect(on.ok && on.input.reminderMs).toBe(900_000);
  });

  test("an event switched off leaves the list and one switched on joins it in the canonical order", () => {
    const draft = typed({});
    const without = withEvent(draft, "down", false);
    expect(without.events).toEqual([
      "recovered",
      "degraded_started",
      "degraded_ended",
      "certificate_expiring",
    ]);
    expect(withEvent(without, "down", true).events).toEqual([
      ...monitorEventKinds,
    ]);
    expect(withEvent(draft, "down", true).events).toEqual([
      ...monitorEventKinds,
    ]);
  });

  test("the reminder's interval is chosen from 5 minutes to 24 hours, as a number of milliseconds", () => {
    expect(reminderChoicesMs[0]).toBe(300_000);
    expect(reminderChoicesMs.at(-1)).toBe(86_400_000);
    expect(reminderChoicesMs).toContain(3_600_000);
    expect(withField(typed({}), "reminderMs", "900000").reminderMs).toBe(
      900_000
    );
  });
});

describe("edges of the events and reminder in the form", () => {
  test("a reminder repeats the down notification, so with the down event off it posts no interval", () => {
    const parsed = inputOf(
      typed({ events: ["recovered"], reminder: true, reminderMs: 900_000 })
    );
    expect(parsed.ok && parsed.input.reminderMs).toBe(undefined);
  });

  test("a stored monitor with every event off reads back with none, not the defaults", () => {
    const draft = draftOf(
      monitorOf({ ...tcpFields, events: [] }),
      noCredentials
    );
    expect(draft.events).toEqual([]);
    const parsed = inputOf(draft);
    expect(parsed.ok && parsed.input.events).toEqual([]);
  });
});
