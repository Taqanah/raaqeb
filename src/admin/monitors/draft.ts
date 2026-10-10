/**
 * The monitor form's draft: every field as the
 * operator types it, in the form's units (seconds for the timeout, days for
 * retention), turned into what the server functions post by the one Zod
 * schema. A refusal becomes one catalog message per field, keyed by the
 * path of the posted input (`config.url`, `credentials.headers.0.name`).
 * Pure: the form holds one draft in state and calls these.
 */
import type { z } from "zod";
import { normalizeDigits } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { tlsExpiryDefaultDays } from "@/shared/schemas/certificate.ts";
import type { ChannelChoice } from "@/shared/schemas/channel.ts";
import {
  type CredentialsView,
  noCredentials,
} from "@/shared/schemas/credentials.ts";
import {
  type Assertion,
  assertionSchema,
  type CaptureMode,
  type CheckType,
  captureModes,
  checkTypes,
  type DatabaseCheckType,
  type DnsConfig,
  type DnsRecordType,
  type DockerConfig,
  databaseCheckTypes,
  defaultAssertions,
  dnsRecordTypes,
  dockerSocketPath,
  type HeartbeatConfig,
  type HttpConfig,
  httpMethods,
  isDatabaseCheckType,
  isDatabaseConfig,
  listSeparator,
  type Monitor,
  type MonitorConfig,
  type MonitorEventKind,
  type MonitorInput,
  type MonitorTest,
  monitorDefaults,
  monitorEventKinds,
  monitorInputSchema,
  reminderDefaultMs,
  retentionDaysMax,
  retentionDaysMin,
  retriesMax,
  type TcpConfig,
  timeoutMaxMs,
  timeoutMinMs,
} from "@/shared/schemas/monitor.ts";

/** The form's first choice of check type: the three databases sit under one, with a choice of their own beside it. */
export const typeChoices = [
  "http",
  "tcp",
  "dns",
  "database",
  "docker",
  "heartbeat",
] as const;
export type TypeChoice = (typeof typeChoices)[number];

/** The first choice a check type sits under. */
export function typeChoiceOf(type: CheckType): TypeChoice {
  return isDatabaseCheckType(type) ? "database" : type;
}

export type HttpMethod = Extract<
  MonitorInput["config"],
  { type: "http" }
>["method"];

/** One assertion row: every kind's fields as text, so switching the kind keeps what was typed. */
export interface AssertionDraft {
  /** The status set as typed: `2xx, 301`. */
  readonly codes: string;
  /** A stable React key for the row. */
  readonly key: string;
  readonly kind: Assertion["kind"];
  /** The response time in milliseconds, as typed. */
  readonly ms: string;
  /** The header name of a header assertion. */
  readonly name: string;
  readonly path: string;
  readonly pattern: string;
  readonly text: string;
  readonly value: string;
}

/** One custom request header row; `storedName` is the name it was stored under, whose value an empty field keeps while the name is unchanged. */
export interface HeaderDraft {
  readonly key: string;
  readonly name: string;
  readonly storedName: string | undefined;
  readonly value: string;
}

/** The units a heartbeat's period and grace period are typed in. */
export const durationUnits = ["seconds", "minutes", "hours", "days"] as const;
export type DurationUnit = (typeof durationUnits)[number];

/** A heartbeat monitor's schedule: "every N" or a cron expression. */
export const scheduleKinds = ["every", "cron"] as const;
export type ScheduleKind = (typeof scheduleKinds)[number];

export const authKinds = ["none", "basic", "bearer"] as const;
export type AuthKind = (typeof authKinds)[number];

export const assertionKinds = assertionSchema.options.map(
  (option) => option.shape.kind.value
);

export interface MonitorDraft {
  /** The text a database monitor's first answered value must equal; empty accepts any answer. */
  readonly answerExpected: string;
  readonly assertions: readonly AssertionDraft[];
  readonly auth: AuthKind;
  readonly body: string;
  readonly captureMode: CaptureMode;
  /** The ids of the channels the monitor selects. */
  readonly channels: readonly string[];
  /** A database monitor's connection URL as typed; empty keeps the stored one while the check type is the one it was stored for. */
  readonly connectionUrl: string;
  /** A Docker monitor's container name, as typed or chosen from the daemon's list. */
  readonly container: string;
  /** A heartbeat monitor's cron expression, as typed. */
  readonly cron: string;
  /** The degraded threshold in milliseconds; empty is off. */
  readonly degradedMs: string;
  readonly description: string;
  readonly dnsName: string;
  /** A Docker monitor's endpoint: a Unix socket's path or an Engine API's URL. */
  readonly dockerEndpoint: string;
  /** The monitor events switched on, in the canonical order. */
  readonly events: readonly MonitorEventKind[];
  /** A heartbeat monitor's "every N", as typed in `everyUnit`. */
  readonly every: string;
  readonly everyUnit: DurationUnit;
  readonly expected: string;
  readonly followRedirects: boolean;
  /** A heartbeat monitor's grace period, as typed in `graceUnit`; empty is a fifth of the period. */
  readonly grace: string;
  readonly graceUnit: DurationUnit;
  readonly group: string;
  readonly headers: readonly HeaderDraft[];
  readonly host: string;
  readonly ignoreTlsErrors: boolean;
  readonly intervalMs: number;
  readonly method: HttpMethod;
  readonly name: string;
  /** Whether the monitor has its own retention; off follows the install default. */
  readonly ownRetention: boolean;
  readonly password: string;
  readonly port: string;
  /** A database monitor's query or Redis command, as typed; empty runs the default. */
  readonly query: string;
  readonly recordType: DnsRecordType;
  /** Whether a reminder repeats "still down". */
  readonly reminder: boolean;
  /** The reminder's interval, kept while the reminder is off. */
  readonly reminderMs: number;
  /** Whether saving gives the heartbeat monitor a new URL, retiring the old one. */
  readonly renewHeartbeatUrl: boolean;
  readonly resolver: string;
  /** The days of the monitor's own retention, kept while the install default is chosen. */
  readonly retentionDays: string;
  readonly retries: string;
  readonly scheduleKind: ScheduleKind;
  /** The stored auth kind, whose secret an empty field keeps. */
  readonly storedAuth: "basic" | "bearer" | undefined;
  /** The check type of the monitor whose connection URL is stored, which an empty field keeps for that type alone. */
  readonly storedUrlType: DatabaseCheckType | undefined;
  /** Tags as typed, separated by commas (Latin or Arabic). */
  readonly tags: string;
  readonly timeoutSeconds: string;
  readonly tlsExpiry: boolean;
  readonly tlsExpiryDays: string;
  readonly token: string;
  readonly type: CheckType;
  readonly url: string;
  readonly user: string;
}

/** A refusal worded through the catalog, with the values its message names. */
export interface FieldError {
  readonly id: MessageId;
  readonly values?: Readonly<Record<string, number | string>>;
}

/** The first refusal of each field, by the posted input's path joined with dots. */
export type FieldErrors = Readonly<Partial<Record<string, FieldError>>>;

export type DraftParse =
  | { readonly ok: true; readonly input: MonitorInput }
  | { readonly ok: false; readonly errors: FieldErrors };

/** The intervals the form offers, 20 s to 24 h; a stored value outside the list is offered too. */
export const intervalChoicesMs: readonly number[] = [
  20_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 21_600_000, 43_200_000, 86_400_000,
];

const blankAssertion = {
  codes: "2xx",
  ms: "",
  name: "",
  path: "",
  pattern: "",
  text: "",
  value: "",
};

/** A new monitor's draft, which selects the channels that apply to new monitors, or the draft of the monitor to edit with the names of its stored credentials. */
export function draftOf(
  monitor: Monitor | undefined,
  credentials: CredentialsView,
  channels: readonly ChannelChoice[] = []
): MonitorDraft {
  const config = monitor?.config;
  return {
    ...fieldsDraft(monitor),
    ...httpDraft(config?.type === "http" ? config : undefined),
    ...tcpDraft(config?.type === "tcp" ? config : undefined),
    ...dnsDraft(config?.type === "dns" ? config : undefined),
    ...databaseDraft(config, credentials),
    ...dockerDraft(config?.type === "docker" ? config : undefined),
    ...credentialsDraft(credentials),
    ...heartbeatDraft(config?.type === "heartbeat" ? config : undefined),
    channels:
      monitor?.channels ??
      channels.filter((each) => each.appliesToNew).map((each) => each.id),
    type: config?.type ?? "http",
  };
}

/** A duplicate's draft: every field of the original under a new name, and no credentials, which the operator types again. */
export function copyDraftOf(original: Monitor, name: string): MonitorDraft {
  return { ...draftOf(original, noCredentials), name };
}

/** A new heartbeat monitor expects one every hour. */
const newHeartbeatPeriod = { amount: "1", unit: "hours" } as const;

function heartbeatDraft(config: HeartbeatConfig | undefined) {
  const { schedule } = config ?? {};
  const every =
    schedule?.kind === "every"
      ? durationDraft(schedule.everyMs)
      : newHeartbeatPeriod;
  const grace =
    config?.graceMs === undefined
      ? { amount: "", unit: "minutes" as const }
      : durationDraft(config.graceMs);
  return {
    cron: schedule?.kind === "cron" ? schedule.expression : "",
    every: every.amount,
    everyUnit: every.unit,
    grace: grace.amount,
    graceUnit: grace.unit,
    renewHeartbeatUrl: false,
    scheduleKind: schedule?.kind ?? "every",
  };
}

const unitMs: Readonly<Record<DurationUnit, number>> = {
  days: 86_400_000,
  hours: 3_600_000,
  minutes: 60_000,
  seconds: 1000,
};

/** A duration as the form shows it: the amount in the largest unit that holds it whole. */
export function durationDraft(ms: number): {
  readonly amount: string;
  readonly unit: DurationUnit;
} {
  const unit =
    [...durationUnits].reverse().find((each) => ms % unitMs[each] === 0) ??
    "seconds";
  return { amount: String(ms / unitMs[unit]), unit };
}

/** The reminder intervals the form offers, 5 minutes to 24 hours; a stored value outside the list is offered too. */
export const reminderChoicesMs: readonly number[] = [
  300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000,
  21_600_000, 43_200_000, 86_400_000,
];

/** The draft with the monitor event switched on or off; the list keeps the canonical order. */
export function withEvent(
  draft: MonitorDraft,
  kind: MonitorEventKind,
  on: boolean
): MonitorDraft {
  return {
    ...draft,
    events: monitorEventKinds.filter((each) =>
      each === kind ? on : draft.events.includes(each)
    ),
  };
}

/** The draft with the channel selected or not; the selection keeps the order the channels are listed in. */
export function withChannel(
  draft: MonitorDraft,
  channels: readonly ChannelChoice[],
  id: string,
  selected: boolean
): MonitorDraft {
  const chosen = new Set(draft.channels);
  if (selected) {
    chosen.add(id);
  } else {
    chosen.delete(id);
  }
  return {
    ...draft,
    channels: channels
      .map((each) => each.id)
      .filter((each) => chosen.has(each)),
  };
}

/** The shell line a job runs to send a heartbeat: fails on an error status, quiet otherwise, retries, gives up after ten seconds. */
export function curlLine(url: string): string {
  return `curl -fsS -m 10 --retry 3 -o /dev/null ${url}`;
}

function fieldsDraft(monitor: Monitor | undefined) {
  return {
    degradedMs: text(monitor?.degradedMs),
    description: monitor?.description ?? "",
    events: monitor?.events ?? [...monitorEventKinds],
    reminder: monitor?.reminderMs !== undefined,
    reminderMs: monitor?.reminderMs ?? reminderDefaultMs,
    group: monitor?.group ?? "",
    intervalMs: monitor?.intervalMs ?? monitorDefaults.intervalMs,
    name: monitor?.name ?? "",
    ownRetention: monitor?.retentionDays !== undefined,
    retentionDays: text(monitor?.retentionDays),
    retries: String(monitor?.retries ?? monitorDefaults.retries),
    tags: (monitor?.tags ?? []).join(", "),
    timeoutSeconds: String(
      (monitor?.timeoutMs ?? monitorDefaults.timeoutMs) / 1000
    ),
  };
}

function httpDraft(config: HttpConfig | undefined) {
  return {
    assertions: (config?.assertions ?? defaultAssertions).map(
      (assertion, index) => assertionDraft(assertion, `a${index}`)
    ),
    body: config?.body ?? "",
    captureMode: config?.captureMode ?? "off",
    followRedirects: config?.followRedirects ?? true,
    ignoreTlsErrors: config?.ignoreTlsErrors ?? false,
    method: config?.method ?? "GET",
    tlsExpiry: config?.tlsExpiryDays !== undefined,
    tlsExpiryDays: String(config?.tlsExpiryDays ?? tlsExpiryDefaultDays),
    url: config?.url ?? "",
  };
}

function tcpDraft(config: TcpConfig | undefined) {
  return { host: config?.host ?? "", port: text(config?.port) };
}

function dnsDraft(config: DnsConfig | undefined) {
  return {
    dnsName: config?.name ?? "",
    expected: config?.expected ?? "",
    recordType: config?.recordType ?? "A",
    resolver: config?.resolver ?? "",
  };
}

/** A database monitor's query and expected value; the connection URL is never read back, only whether one is stored for the monitor's check type. */
function databaseDraft(
  config: MonitorConfig | undefined,
  credentials: CredentialsView
): {
  readonly answerExpected: string;
  readonly connectionUrl: string;
  readonly query: string;
  readonly storedUrlType: DatabaseCheckType | undefined;
} {
  const database = config && isDatabaseConfig(config) ? config : undefined;
  return {
    answerExpected: database?.expected ?? "",
    connectionUrl: "",
    query: database?.query ?? "",
    storedUrlType: credentials.url ? database?.type : undefined,
  };
}

/** A Docker monitor's endpoint and container; a new one starts at the local socket. */
function dockerDraft(config: DockerConfig | undefined): {
  readonly container: string;
  readonly dockerEndpoint: string;
} {
  return {
    container: config?.container ?? "",
    dockerEndpoint: config?.endpoint ?? dockerSocketPath,
  };
}

/** The stored credentials' names, with every secret field empty. */
function credentialsDraft({ auth, headers }: CredentialsView) {
  const kind: AuthKind = auth?.kind ?? "none";
  return {
    auth: kind,
    headers: headers.map((header, index) => ({
      key: `h${index}`,
      name: header.name,
      storedName: header.name,
      value: "",
    })),
    password: "",
    storedAuth: auth?.kind,
    token: "",
    user: auth?.kind === "basic" ? auth.user : "",
  };
}

function text(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function assertionDraft(assertion: Assertion, key: string): AssertionDraft {
  const row = { ...blankAssertion, key, kind: assertion.kind };
  switch (assertion.kind) {
    case "status":
      return { ...row, codes: assertion.codes.join(", ") };
    case "body_contains":
    case "body_not_contains":
      return { ...row, text: assertion.text };
    case "json_equals":
      return { ...row, path: assertion.path, value: assertion.value };
    case "json_matches":
      return { ...row, path: assertion.path, pattern: assertion.pattern };
    case "header_equals":
      return { ...row, name: assertion.name, value: assertion.value };
    default:
      return { ...row, ms: String(assertion.ms) };
  }
}

/** A fresh assertion row of the kind, with the new row's key. */
export function newAssertion(
  kind: Assertion["kind"],
  key: string
): AssertionDraft {
  return { ...blankAssertion, key, kind };
}

// A minus sign is part of a number, so a negative one is refused by the range it breaks.
const wholeDigits = /^-?\d+$/;
const decimalSeconds = /^-?\d+(\.\d{1,3})?$/;

/** A typed number: nothing when empty, a whole number, or false when it is not one. Arabic-Indic digits count. */
function wholeNumber(typed: string): number | undefined | false {
  const trimmed = normalizeDigits(typed).trim();
  if (trimmed === "") {
    return;
  }
  return wholeDigits.test(trimmed) ? Number(trimmed) : false;
}

/** The ranges a numeric field is worded with, in the form's units. */
const ranges: Readonly<Record<string, { min: number; max: number }>> = {
  "config.port": { max: 65_535, min: 1 },
  "config.tlsExpiryDays": { max: 365, min: 1 },
  degradedMs: { max: timeoutMaxMs, min: 1 },
  ms: { max: timeoutMaxMs, min: 1 },
  retentionDays: { max: retentionDaysMax, min: retentionDaysMin },
  retries: { max: retriesMax, min: 0 },
  timeoutMs: { max: timeoutMaxMs / 1000, min: timeoutMinMs / 1000 },
};

/** Collects the refusals found before the schema runs: required text and numbers that are not whole. */
class Refusals {
  readonly errors: Record<string, FieldError> = {};

  add(path: string, error: FieldError): void {
    this.errors[path] ??= error;
  }

  /** The text, or a required refusal when it is blank. */
  required(path: string, typed: string): string {
    if (typed.trim() === "") {
      this.add(path, { id: "monitor_error_required" });
    }
    return typed.trim();
  }

  /** The number, nothing when empty and optional, or a refusal. */
  number(path: string, typed: string, required: boolean): number | undefined {
    const value = wholeNumber(typed);
    if (value === false) {
      this.add(path, { id: "monitor_error_whole_number" });
      return;
    }
    if (value === undefined && required) {
      this.add(path, { id: "monitor_error_required" });
    }
    return value;
  }

  /** A whole amount in a unit, as milliseconds; required. */
  duration(
    path: string,
    typed: string,
    unit: DurationUnit
  ): number | undefined {
    const amount = this.number(path, typed, true);
    return amount === undefined ? undefined : amount * unitMs[unit];
  }

  /** Seconds typed with up to three decimals (a stored 2500 ms reads as 2.5), as whole milliseconds; required. */
  seconds(path: string, typed: string): number | undefined {
    const written = normalizeDigits(typed).replace("٫", ".").trim();
    if (written === "") {
      this.add(path, { id: "monitor_error_required" });
      return;
    }
    if (!decimalSeconds.test(written)) {
      this.add(path, { id: "monitor_error_number" });
      return;
    }
    return Math.round(Number(written) * 1000);
  }
}

/** What the form posts, or the refusal of every field that does not fit. */
export function inputOf(draft: MonitorDraft): DraftParse {
  const refusals = new Refusals();
  const raw = {
    config: configOf(draft, refusals),
    // Only an HTTP request and a database monitor send credentials; what the other type's fields still hold stays in the draft.
    channels: draft.channels,
    credentials: postedCredentialsOf(draft, refusals),
    description: optionalText(draft.description),
    events: draft.events,
    group: optionalText(draft.group),
    name: refusals.required("name", draft.name),
    // A reminder repeats the down notification, so it posts only with the down event on.
    reminderMs:
      draft.reminder && draft.events.includes("down")
        ? draft.reminderMs
        : undefined,
    retentionDays: draft.ownRetention
      ? refusals.number("retentionDays", draft.retentionDays, true)
      : undefined,
    tags: tagsOf(draft.tags),
    ...scheduleOf(draft, refusals),
  };
  const parsed = monitorInputSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [path, error] = refusalOf(issue, draft.type);
      refusals.add(path, error);
    }
  }
  if (Object.keys(refusals.errors).length > 0 || !parsed.success) {
    return { errors: refusals.errors, ok: false };
  }
  return { input: parsed.data, ok: true };
}

/** The check schedule; a heartbeat monitor has none, so it posts the defaults and no threshold, whatever the hidden fields hold. */
function scheduleOf(draft: MonitorDraft, refusals: Refusals) {
  if (draft.type === "heartbeat") {
    return { ...monitorDefaults, degradedMs: undefined };
  }
  return {
    degradedMs: refusals.number("degradedMs", draft.degradedMs, false),
    intervalMs: draft.intervalMs,
    retries: refusals.number("retries", draft.retries, true),
    timeoutMs: refusals.seconds("timeoutMs", draft.timeoutSeconds),
  };
}

/** A heartbeat monitor's schedule and grace period, in milliseconds from their units. */
function heartbeatConfigOf(draft: MonitorDraft, refusals: Refusals): unknown {
  const graceMs =
    draft.grace.trim() === ""
      ? undefined
      : refusals.duration("config.graceMs", draft.grace, draft.graceUnit);
  return {
    ...(graceMs !== undefined && { graceMs }),
    schedule:
      draft.scheduleKind === "cron"
        ? {
            expression: refusals.required(
              "config.schedule.expression",
              draft.cron
            ),
            kind: "cron",
          }
        : {
            everyMs: refusals.duration(
              "config.schedule.everyMs",
              draft.every,
              draft.everyUnit
            ),
            kind: "every",
          },
    type: "heartbeat",
  };
}

/** Whether the address is https, the only kind with a certificate to warn about. */
export function isHttps(url: string): boolean {
  return url.trim().toLowerCase().startsWith("https://");
}

function optionalText(typed: string): string | undefined {
  return typed.trim() === "" ? undefined : typed.trim();
}

/** The credentials the form posts for its check type: an HTTP request's, a database monitor's URL, or none. */
function postedCredentialsOf(draft: MonitorDraft, refusals: Refusals): unknown {
  if (draft.type === "http") {
    return credentialsOf(draft, refusals);
  }
  if (!isDatabaseCheckType(draft.type)) {
    return;
  }
  const url = draft.connectionUrl.trim();
  // An empty field keeps the stored URL, but only the one stored for this check type.
  if (url === "" && draft.storedUrlType === draft.type) {
    return;
  }
  return { headers: [], url: refusals.required("credentials.url", url) };
}

function configOf(draft: MonitorDraft, refusals: Refusals): unknown {
  switch (draft.type) {
    case "heartbeat":
      return heartbeatConfigOf(draft, refusals);
    case "postgres":
    case "mysql":
    case "redis":
      return {
        expected: optionalText(draft.answerExpected),
        query: optionalText(draft.query),
        type: draft.type,
      };
    case "docker":
      return {
        container: refusals.required("config.container", draft.container),
        endpoint: refusals.required("config.endpoint", draft.dockerEndpoint),
        type: "docker",
      };
    case "tcp":
      return {
        host: refusals.required("config.host", draft.host),
        port: refusals.number("config.port", draft.port, true),
        type: "tcp",
      };
    case "dns":
      return {
        expected: optionalText(draft.expected),
        name: refusals.required("config.name", draft.dnsName),
        recordType: draft.recordType,
        resolver: optionalText(draft.resolver),
        type: "dns",
      };
    default:
      return {
        assertions: draft.assertions.map((row, index) =>
          assertionOf(row, `config.assertions.${index}`, refusals)
        ),
        body: draft.body === "" ? undefined : draft.body,
        captureMode: draft.captureMode,
        followRedirects: draft.followRedirects,
        ignoreTlsErrors: draft.ignoreTlsErrors,
        method: draft.method,
        type: "http",
        url: refusals.required("config.url", draft.url),
        // Off posts no day count at all (absent means off); only an https address has a certificate to read.
        ...(draft.tlsExpiry &&
          isHttps(draft.url) && {
            tlsExpiryDays: refusals.number(
              "config.tlsExpiryDays",
              draft.tlsExpiryDays,
              true
            ),
          }),
      };
  }
}

function assertionOf(
  row: AssertionDraft,
  path: string,
  refusals: Refusals
): unknown {
  const { kind } = row;
  switch (kind) {
    case "status":
      return {
        codes: row.codes
          .split(listSeparator)
          .map((code) => code.trim())
          .filter((code) => code !== ""),
        kind,
      };
    case "body_contains":
    case "body_not_contains":
      return { kind, text: row.text };
    case "json_equals":
      return { kind, path: row.path.trim(), value: row.value };
    case "json_matches":
      return { kind, path: row.path.trim(), pattern: row.pattern };
    case "header_equals":
      return { kind, name: row.name.trim(), value: row.value };
    default:
      return { kind, ms: refusals.number(`${path}.ms`, row.ms, true) };
  }
}

/** The credentials the form posts: a stored secret left empty is left out, so the server keeps it. */
function credentialsOf(draft: MonitorDraft, refusals: Refusals): unknown {
  const keep = (kind: "basic" | "bearer", typed: string) =>
    draft.storedAuth === kind && typed === "" ? undefined : typed;
  const headers = draft.headers.map((header, index) => {
    const name = header.name.trim();
    const stored = header.storedName;
    if (stored === undefined || header.value !== "") {
      return { name, value: header.value };
    }
    // The kept value belongs to the stored name; a renamed header needs its value typed again.
    if (name.toLowerCase() !== stored.toLowerCase()) {
      refusals.add(`credentials.headers.${index}.value`, {
        id: "monitor_error_required",
      });
    }
    return { name, value: undefined };
  });
  let auth: unknown;
  if (draft.auth === "basic") {
    refusals.required("credentials.auth.user", draft.user);
    auth = {
      kind: "basic",
      password: keep("basic", draft.password),
      user: draft.user,
    };
  } else if (draft.auth === "bearer") {
    auth = { kind: "bearer", token: keep("bearer", draft.token) };
  }
  return auth === undefined && headers.length === 0
    ? undefined
    : { auth, headers };
}

/** The field a schema issue belongs to and the message that words it. */
function refusalOf(
  issue: z.core.$ZodIssue,
  type: CheckType
): [string, FieldError] {
  const segments = issue.path.map(String);
  // A status set entry is refused on the row's set, a tag on the tags field.
  const codes = segments.indexOf("codes");
  if (codes >= 0) {
    return [
      segments.slice(0, codes + 1).join("."),
      { id: "monitor_error_status_codes" },
    ];
  }
  if (segments[0] === "tags" && segments.length > 1) {
    return ["tags", wordingOf(issue, "tags")];
  }
  const path = segments.join(".");
  // The schema's own rule about the URL names the type's schemes; its length is a length.
  if (
    path === "credentials.url" &&
    issue.code === "custom" &&
    isDatabaseCheckType(type)
  ) {
    return [path, { id: connectionUrlRefusals[type] }];
  }
  const docker = dockerRefusals[path];
  if (docker?.code === issue.code) {
    return [path, { id: docker.id }];
  }
  return [path, wordingOf(issue, path)];
}

/** A Docker monitor's endpoint and container name, each refused naming its own rule; a length is a length. */
const dockerRefusals: Readonly<
  Partial<Record<string, { code: z.core.$ZodIssue["code"]; id: MessageId }>>
> = {
  "config.container": {
    code: "invalid_format",
    id: "monitor_error_container",
  },
  "config.endpoint": { code: "custom", id: "monitor_error_docker_endpoint" },
};

/** A connection URL another check type reads is refused naming this type's schemes. */
const connectionUrlRefusals: Readonly<Record<DatabaseCheckType, MessageId>> = {
  mysql: "monitor_error_connection_url_mysql",
  postgres: "monitor_error_connection_url_postgres",
  redis: "monitor_error_connection_url_redis",
};

/** The message for an issue on a field; the path decides what a custom or format refusal means. */
function wordingOf(issue: z.core.$ZodIssue, path: string): FieldError {
  const leaf = path.split(".").at(-1) ?? "";
  if (path === "config.url") {
    return {
      id:
        issue.code === "custom"
          ? "monitor_error_url_credentials"
          : "monitor_error_url",
    };
  }
  if (path === "config.host") {
    return { id: "monitor_error_host" };
  }
  if (path === "config.name") {
    return { id: "monitor_error_dns_name" };
  }
  if (path === "config.resolver") {
    return { id: "monitor_error_resolver" };
  }
  if (path === "config.schedule.everyMs") {
    return { id: "monitor_error_period" };
  }
  if (path === "config.graceMs") {
    return { id: "monitor_error_grace" };
  }
  if (path === "config.schedule.expression" && issue.code === "custom") {
    return { id: "monitor_error_cron" };
  }
  if (path.startsWith("credentials.headers.") && leaf === "name") {
    return {
      id:
        issue.code === "custom"
          ? "monitor_error_header_duplicate"
          : "monitor_error_header_name",
    };
  }
  if (issue.code === "custom") {
    const custom: Partial<Record<string, MessageId>> = {
      path: "monitor_error_json_path",
      pattern: "monitor_error_pattern",
      token: "monitor_error_token",
      user: "monitor_error_user",
      value: "monitor_error_header_value",
    };
    return { id: custom[leaf] ?? "monitor_error_invalid" };
  }
  return sizeOf(issue, ranges[path] ?? ranges[leaf]);
}

/** A size or range refusal: a range for numbers, a limit for text and lists, required for empty text. */
function sizeOf(
  issue: z.core.$ZodIssue,
  range: { min: number; max: number } | undefined
): FieldError {
  if (range && (issue.code === "too_small" || issue.code === "too_big")) {
    return { id: "monitor_error_range", values: { ...range } };
  }
  if (issue.code === "too_big") {
    return {
      id:
        issue.origin === "array"
          ? "monitor_error_too_many"
          : "monitor_error_too_long",
      values: { max: Number(issue.maximum) },
    };
  }
  if (issue.code === "too_small" && issue.origin === "string") {
    return { id: "monitor_error_required" };
  }
  return { id: "monitor_error_invalid" };
}

/** The tag names in text typed with Latin or Arabic commas: trimmed, empty ones dropped, each once. */
export function tagsOf(typed: string): string[] {
  const names = typed
    .split(listSeparator)
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return [...new Set(names)];
}

/** The figure for "always" at 60 s. */
const captureDayBytesAtMinute = 5_800_000;

/** What "always" capture costs a day at this interval: about 5.8 MB at 60 s, scaled. */
export function captureBytesPerDay(intervalMs: number): number {
  return Math.round((captureDayBytesAtMinute * 60_000) / intervalMs);
}

export type AssertionState = "passed" | "failed" | "unreached";

/** An assertion as text with its keys in order, so two equal ones read the same whatever order their keys came in. */
function sameText(assertion: Assertion): string {
  return JSON.stringify(
    assertion,
    Object.keys(assertion).sort((a, b) => a.localeCompare(b))
  );
}

/** Each assertion's state in a test: those before the failed one passed, the rest were never evaluated; all passed on a success. */
export function assertionStates(
  assertions: readonly Assertion[],
  test: MonitorTest
): AssertionState[] {
  if (test.result !== "down") {
    return assertions.map(() => "passed");
  }
  const failed = test.failure?.assertion;
  // The evaluator stops at the first failure, so the failed one is the first equal to it.
  const index = failed
    ? assertions.findIndex(
        (assertion) => sameText(assertion) === sameText(failed)
      )
    : -1;
  return assertions.map((_, position) => {
    if (index < 0 || position > index) {
      return "unreached";
    }
    return position === index ? "failed" : "passed";
  });
}

/** The draft's fields a text input edits, by the input's name. */
const textFields = [
  "answerExpected",
  "body",
  "connectionUrl",
  "container",
  "cron",
  "degradedMs",
  "description",
  "dnsName",
  "dockerEndpoint",
  "every",
  "expected",
  "grace",
  "group",
  "host",
  "name",
  "password",
  "port",
  "query",
  "resolver",
  "retentionDays",
  "retries",
  "tags",
  "timeoutSeconds",
  "tlsExpiryDays",
  "token",
  "url",
  "user",
] as const;

/** The text fields an assertion row has, across its kinds. */
export const assertionFields = [
  "codes",
  "ms",
  "name",
  "path",
  "pattern",
  "text",
  "value",
] as const;
const headerFields = ["name", "value"] as const;

/** Narrows a value to one of a list, or nothing. */
function oneOf<T extends string>(
  list: readonly T[],
  value: string | undefined
): T | undefined {
  return list.find((item) => item === value);
}

/** The draft with the field an input names set to what was typed or chosen: `url`, `assertions.1.text`, `headers.0.value`. A name or a choice the form does not have changes nothing. */
export function withField(
  draft: MonitorDraft,
  name: string,
  value: string
): MonitorDraft {
  const [head, position, field] = name.split(".");
  const index = Number(position);
  if (head === "assertions" && field !== undefined) {
    const kind = field === "kind" ? oneOf(assertionKinds, value) : undefined;
    const key = oneOf(assertionFields, field);
    const patch = kind ? { kind } : key && { [key]: value };
    return patch
      ? {
          ...draft,
          assertions: draft.assertions.map((row, at) =>
            at === index ? { ...row, ...patch } : row
          ),
        }
      : draft;
  }
  if (head === "headers" && field !== undefined) {
    const key = oneOf(headerFields, field);
    return key
      ? {
          ...draft,
          headers: draft.headers.map((row, at) =>
            at === index ? { ...row, [key]: value } : row
          ),
        }
      : draft;
  }
  return withChoice(draft, name, value);
}

function withChoice(
  draft: MonitorDraft,
  name: string,
  value: string
): MonitorDraft {
  const set = <K extends keyof MonitorDraft>(
    key: K,
    chosen: MonitorDraft[K] | undefined
  ): MonitorDraft =>
    chosen === undefined ? draft : { ...draft, [key]: chosen };
  const typed = oneOf(textFields, name);
  if (typed) {
    return set(typed, value);
  }
  switch (name) {
    case "auth":
      return set("auth", oneOf(authKinds, value));
    case "captureMode":
      return set("captureMode", oneOf(captureModes, value));
    case "everyUnit":
      return set("everyUnit", oneOf(durationUnits, value));
    case "graceUnit":
      return set("graceUnit", oneOf(durationUnits, value));
    case "scheduleKind":
      return set("scheduleKind", oneOf(scheduleKinds, value));
    case "intervalMs":
      return set("intervalMs", wholeNumber(value) || undefined);
    case "reminderMs":
      return set("reminderMs", wholeNumber(value) || undefined);
    case "method":
      return set("method", oneOf(httpMethods, value));
    case "recordType":
      return set("recordType", oneOf(dnsRecordTypes, value));
    case "databaseType":
      return set("type", oneOf(databaseCheckTypes, value));
    case "type":
      // The database choice keeps the database already chosen, and starts at Postgres.
      return value === "database"
        ? set("type", isDatabaseCheckType(draft.type) ? draft.type : "postgres")
        : set("type", oneOf(checkTypes, value));
    default:
      return draft;
  }
}
