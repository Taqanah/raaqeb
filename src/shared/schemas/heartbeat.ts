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

/** The unique URL of a heartbeat monitor at this origin. */
export function heartbeatUrl(origin: string, token: string): string {
  return `${origin.replace(trailingSlash, "")}${heartbeatPathPrefix}${token}`;
}

export interface Heartbeat {
  readonly arrivedAt: number;
  /** The caller's address behind the trusted proxies; none when the entry could not tell. */
  readonly sourceIp: string | undefined;
}

/** What the edit form shows of a heartbeat monitor: its unique URL and the last heartbeat. */
export interface HeartbeatView {
  readonly last: Heartbeat | undefined;
  readonly url: string;
}
