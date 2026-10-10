/**
 * The reason dictionary (CONTEXT.md "Reason", ADR-0004): why a
 * check ended as it did, as one integer code from this closed list plus a
 * small parameter object. A code is stored in the head table and the sealed
 * day, so a number is never reused: a retired reason keeps its number here
 * with a comment. The parameters live in the failure detail,
 * which the nightly job purges after the raw window, so every reason renders
 * whole from its code alone; the parameters render under it as label-value
 * tokens. Adding a reason adds a code here and two catalog messages,
 * `reason_<name>` in Arabic and English, in the same pull request.
 */
import { z } from "zod";

export const reasons = {
  ok: 0,
  timeout: 1,
  dns_failed: 2,
  connection_refused: 3,
  connection_failed: 4,
  certificate_expired: 5,
  certificate_invalid: 6,
  unexpected_status: 7,
  assertion_failed: 8,
  slow: 9,
  too_many_redirects: 10,
  heartbeat_late: 11,
  unknown: 12,
  dns_mismatch: 13,
  auth_failed: 14,
  query_failed: 15,
  container_not_found: 16,
  container_not_running: 17,
  container_restarting: 18,
  container_paused: 19,
  container_dead: 20,
  container_unhealthy: 21,
  tls_required: 22,
} as const;

export type ReasonName = keyof typeof reasons;
export type ReasonCode = (typeof reasons)[ReasonName];
export const reasonNames = Object.keys(reasons) as ReasonName[];
/** A reason by its name, as machine values carry it (a notification's payload). */
export const reasonNameSchema = z.literal(reasonNames);

/** The name a stored code stands for, or nothing for a code this version does not know. */
export function reasonName(code: number): ReasonName | undefined {
  return reasonNames.find((name) => reasons[name] === code);
}

/** The catalog message that renders a reason in the reader's locale. */
export function reasonMessageId(name: ReasonName): `reason_${ReasonName}` {
  return `reason_${name}`;
}

/** An observed value kept beside a failed assertion is cut to this length. */
export const observedMaxLength = 200;

/**
 * What a reason saw, stored as JSON text in the failure detail; the `reason`
 * field names the reason so the object parses on its own. Expected and
 * observed values are text, rendered as machine tokens.
 */
export const reasonParamsSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("ok") }),
  z.object({ reason: z.literal("timeout"), timeoutMs: z.int().positive() }),
  z.object({ host: z.string(), reason: z.literal("dns_failed") }),
  z.object({
    host: z.string(),
    port: z.int().min(1).max(65_535),
    reason: z.literal("connection_refused"),
  }),
  /** `code` is the driver's own code (reset, unreachable, closed). */
  z.object({ code: z.string(), reason: z.literal("connection_failed") }),
  z.object({ reason: z.literal("certificate_expired") }),
  /** `code` is the driver's verification code (self signed, name mismatch, not yet valid). */
  z.object({ code: z.string(), reason: z.literal("certificate_invalid") }),
  z.object({
    expected: z.array(z.string()),
    observed: z.int(),
    reason: z.literal("unexpected_status"),
  }),
  z.object({
    expected: z.string().max(observedMaxLength),
    observed: z.string().max(observedMaxLength),
    reason: z.literal("assertion_failed"),
  }),
  z.object({
    limitMs: z.int().positive(),
    observedMs: z.int().min(0),
    reason: z.literal("slow"),
  }),
  z.object({ reason: z.literal("too_many_redirects") }),
  z.object({
    graceMs: z.int().positive(),
    reason: z.literal("heartbeat_late"),
  }),
  z.object({ reason: z.literal("unknown") }),
  /** A DNS answer that did not match the monitor's expected value; both as text. */
  z.object({
    expected: z.string().max(observedMaxLength),
    observed: z.string().max(observedMaxLength),
    reason: z.literal("dns_mismatch"),
  }),
  /** The database server refused the sign-in (a user, a password or a database it does not accept); `code` is its own (`28P01`, `1045`) or the driver's. */
  z.object({ code: z.string(), reason: z.literal("auth_failed") }),
  /** The database server signed in and refused the query; `code` is its own (`42703`, `1054`) or the driver's. */
  z.object({ code: z.string(), reason: z.literal("query_failed") }),
  /** The Docker daemon knows no container by the monitor's name. */
  z.object({ reason: z.literal("container_not_found") }),
  /** The container is stopped: `state` is Docker's word (`exited`, `created`, `removing`), `exitCode` its last exit code. */
  z.object({
    exitCode: z.int(),
    reason: z.literal("container_not_running"),
    state: z.string().max(observedMaxLength),
  }),
  /** Docker is restarting the container by its restart policy; `exitCode` is the run that ended. */
  z.object({ exitCode: z.int(), reason: z.literal("container_restarting") }),
  z.object({ reason: z.literal("container_paused") }),
  /** Docker could not stop or remove the container. */
  z.object({ reason: z.literal("container_dead") }),
  /** The container runs and its HEALTHCHECK reports it unhealthy. */
  z.object({ reason: z.literal("container_unhealthy") }),
  /** The database server signs in only over an encrypted connection and the URL asked for none: MySQL 8's default sign-in over a plain one. */
  z.object({ reason: z.literal("tls_required") }),
]);
export type ReasonParams = z.infer<typeof reasonParamsSchema>;
