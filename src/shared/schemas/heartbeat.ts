/**
 * A heartbeat (CONTEXT.md "Heartbeat"): one incoming call to a
 * heartbeat monitor's unique URL, kept with its arrival time and source
 * address. The URL carries the monitor's token: 16
 * random bytes as base64url, stored in clear so the form can show it again.
 */
import { z } from "zod";

/** The path a heartbeat monitor's job calls, before the token. */
export const heartbeatPathPrefix = "/api/heartbeat/";

const trailingSlash = /\/$/;

/** 16 random bytes as base64url without padding: 22 characters. */
export const heartbeatTokenSchema = z.string().regex(/^[\w-]{22}$/);

/** The path segment after the token that says the job failed. */
export const heartbeatFailSuffix = "/fail";

/** The unique URL of a heartbeat monitor at this origin. */
export function heartbeatUrl(origin: string, token: string): string {
  return `${origin.replace(trailingSlash, "")}${heartbeatPathPrefix}${token}`;
}

/** What a heartbeat that reports failure carries: the job's exit code and a short message, each when the call gave one. */
export interface HeartbeatFailure {
  readonly exitCode: number | undefined;
  readonly message: string | undefined;
}

/** A message is kept to this many characters, as a failure's raw error text is (ADR-0004). */
export const heartbeatMessageMaxLength = 256;

/** The largest exit code a job can give, which the call may carry. */
export const heartbeatExitCodeMax = 255;

/**
 * A message as a failure detail keeps it: control and format characters and
 * runs of whitespace become one space, the ends are trimmed, and it is cut to
 * `heartbeatMessageMaxLength` characters. Nothing for an empty message.
 */
export function cleanHeartbeatMessage(text: string): string | undefined {
  const line = text.replace(formatText, "").replace(unsafeText, " ").trim();
  // Characters, not UTF-16 units, so the cut never splits a pair.
  return line === ""
    ? undefined
    : [...line].slice(0, heartbeatMessageMaxLength).join("").trimEnd();
}

/** Whitespace and control characters, each run of them one space. */
const unsafeText = /[\s\p{Cc}]+/gu;
/** Format characters, which leave no space where they were. */
const formatText = /\p{Cf}/gu;

export interface Heartbeat {
  readonly arrivedAt: number;
  /** What the call reported when it said the job failed; nothing for a heartbeat that says it ran. */
  readonly failure: HeartbeatFailure | undefined;
  /** The caller's address behind the trusted proxies; none when the entry could not tell. */
  readonly sourceIp: string | undefined;
}

/** How many of its latest heartbeats a heartbeat monitor's page lists. */
export const heartbeatsShown = 10;

/** What the edit form shows of a heartbeat monitor: its unique URL, the last heartbeat and the latest ones with what each reported. */
export interface HeartbeatView {
  readonly last: Heartbeat | undefined;
  /** Newest first, up to `heartbeatsShown`; the first is `last`. */
  readonly recent: readonly Heartbeat[];
  readonly url: string;
}
