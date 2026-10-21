/**
 * Locations and probes (CONTEXT.md "Location", "Main location", "Probe",
 * "Probe token", "Confirmation count"; ADR-0012): the protocol a probe
 * speaks with the install, version 1, and what the locations page and a
 * monitor's page read. A probe sends ages, never wall-clock times, so its
 * clock never moves a check.
 */
import { z } from "zod";
import { type CheckResult, checkResults, errorMaxLength } from "./check.ts";
import { credentialsSchema } from "./credentials.ts";
import {
  assertionSchema,
  intervalMaxMs,
  intervalMinMs,
  monitorConfigSchema,
  retriesMax,
  timeoutMaxMs,
  timeoutMinMs,
} from "./monitor.ts";
import { reasonNameSchema, reasonParamsSchema } from "./reason.ts";

/** The protocol this build speaks, which is in every path. */
export const probeProtocol = 1;
export const assignmentsPath = "/api/probe/v1/assignments";
export const resultsPath = "/api/probe/v1/results";
/** The header a probe names its build in. */
export const probeVersionHeader = "raaqeb-version";
/** The header a probe reports its last request's round trip in, in milliseconds. */
export const roundTripHeader = "raaqeb-round-trip-ms";

export const probeNameMaxLength = 60;
/** One push carries at most this many results. */
export const resultsMax = 1000;

export const probeNameSchema = z.string().trim().min(1).max(probeNameMaxLength);

/** One monitor as its probe gets it: what a check and the schedule need, and its credentials only when it shares them. */
export const probeAssignmentSchema = z.object({
  config: monitorConfigSchema.describe(
    "The monitor's check-type fields, as the install stores them, `type` first among them."
  ),
  credentials: credentialsSchema
    .optional()
    .describe(
      "The monitor's opened credentials, only when it shares them with its probes."
    ),
  degradedMs: z
    .int()
    .positive()
    .max(timeoutMaxMs)
    .optional()
    .describe(
      "The response time over which a check that succeeded is degraded, in milliseconds; absent, never."
    ),
  id: z.string().min(1).describe("The monitor's id."),
  intervalMs: z
    .int()
    .min(intervalMinMs)
    .max(intervalMaxMs)
    .describe("How often to check it, in milliseconds."),
  retries: z
    .int()
    .min(0)
    .max(retriesMax)
    .describe("How many times one check tries again before it is down."),
  timeoutMs: z
    .int()
    .min(timeoutMinMs)
    .max(timeoutMaxMs)
    .describe("How long one attempt may take, in milliseconds."),
  updatedAt: z
    .int()
    .min(0)
    .describe(
      "When the monitor last changed, in UTC milliseconds; a change makes it due at once."
    ),
});
export type ProbeAssignment = z.infer<typeof probeAssignmentSchema>;

/** `GET /api/probe/v1/assignments`: the probe's own monitors. */
export const probeAssignmentsSchema = z.object({
  monitors: z.array(probeAssignmentSchema).describe("The probe's monitors."),
  protocol: z
    .literal(probeProtocol)
    .describe("The protocol's version, the one in the path."),
});
export type ProbeAssignments = z.infer<typeof probeAssignmentsSchema>;

/** The longest age a result may carry: a probe keeps a monitor's latest result while the install is out of reach, and one older than a day says nothing a fresh one would not. */
export const resultAgeMaxMs = 86_400_000;

/** One check a probe ran: its result as a check stores it, and how long before the push it started on the probe's own clock. */
export const probeResultSchema = z.object({
  ageMs: z
    .int()
    .min(0)
    .max(resultAgeMaxMs)
    .describe(
      "How long before this push the check started, in milliseconds on the probe's own clock."
    ),
  attempts: z
    .int()
    .min(1)
    .max(retriesMax + 1)
    .describe("How many tries the check took."),
  bytes: z.int().min(0).describe("Bytes of body read."),
  detail: z
    .object({
      assertion: assertionSchema.optional(),
      error: z.string().max(errorMaxLength).optional(),
      params: reasonParamsSchema,
    })
    .optional()
    .describe(
      "A down check's failure detail: the assertion that failed, the driver's error text and what the reason saw."
    ),
  monitorId: z.string().min(1).describe("The monitor checked."),
  reason: reasonNameSchema.describe("Why the check ended as it did."),
  responseMs: z
    .int()
    .min(0)
    .max(timeoutMaxMs)
    .optional()
    .describe("The last attempt's response time, in milliseconds."),
  result: z.enum(checkResults).describe("The check's result."),
  statusCode: z
    .int()
    .min(100)
    .max(999)
    .optional()
    .describe("An HTTP check's status code, when a response arrived."),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

/** `POST /api/probe/v1/results`. */
export const probeResultsSchema = z.object({
  results: z
    .array(probeResultSchema)
    .max(resultsMax)
    .describe("The latest result of each monitor since the last push."),
});
export type ProbeResults = z.infer<typeof probeResultsSchema>;

/** The answer to a push: the assignments' current tag, so the probe pulls again when it moved. */
export const probeReceiptSchema = z.object({
  dropped: z
    .int()
    .min(0)
    .default(0)
    .describe(
      "How many of the push's results were dropped: past the results one push may carry, or fitting no rule."
    ),
  assignments: z
    .string()
    .describe("The `ETag` of the probe's assignments as they stand now."),
});
export type ProbeReceipt = z.infer<typeof probeReceiptSchema>;

/** A probe as the locations page and the monitor form read it. */
export interface Probe {
  readonly createdAt: number;
  readonly id: string;
  /** When the install last heard from it, to within half a minute; nothing before its first contact. */
  readonly lastSeenAt?: number | undefined;
  readonly name: string;
  /** Its last request's round trip as it measured it. */
  readonly roundTripMs?: number | undefined;
  /** The build it named at its last contact. */
  readonly version?: string | undefined;
}

/** A probe is silent once the install has not heard from it for this long: four of its pulls. */
export const probeSilentAfterMs = 120_000;

/** A location's state on a monitor's page: its latest result while it is fresh, else unknown. */
export interface LocationState {
  /** `main` or a probe's id. */
  readonly location: string;
  /** The probe's name; none for the main location. */
  readonly name?: string | undefined;
  readonly responseMs?: number | undefined;
  /** Nothing while unknown. */
  readonly result?: CheckResult | undefined;
  /** When its latest result's check started. */
  readonly startedAt?: number | undefined;
}

export const probeCreateSchema = z.object({ name: probeNameSchema });
export const probeIdSchema = z.object({ id: z.string().min(1) });

export interface ProbesView {
  /** Where the probes reach the install: its public address, or nothing while none is stored. */
  readonly address: string | undefined;
  readonly now: number;
  readonly probes: readonly Probe[];
  /** The probes whose latest push the install refused whole, which the page never shows as reporting. */
  readonly refused: readonly string[];
}

export type ProbesResult =
  | ({ readonly ok: true } & ProbesView)
  | { readonly ok: false; readonly reason: "unavailable" };

/** A probe made or given a new token: the token, shown once. */
export type ProbeTokenResult =
  | { readonly ok: true; readonly probe: Probe; readonly token: string }
  | {
      readonly ok: false;
      readonly reason: "full" | "not_found" | "unavailable";
    };

export type ProbeRemoveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" };
