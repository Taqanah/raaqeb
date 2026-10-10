/**
 * The HTTP check (CONTEXT.md "Check", "Check type"; HTTP).
 * One call is one check: the attempts with their retries, the success rules,
 * the degraded threshold, the failure detail and the capture. It does no I/O
 * beyond the injected `fetch`, takes `now` and `sleep` as parameters, and
 * never throws: every runtime error is a reason. The body is read to a cap
 * of 1 MB and the rest of the stream is cancelled, so a large page costs
 * bounded memory and bandwidth. Redirects are followed here,
 * not by fetch, up to the cap.
 */
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type { Credentials } from "@/shared/schemas/credentials.ts";
import type { HttpConfig, Monitor } from "@/shared/schemas/monitor.ts";
import { evaluateAssertions } from "./assertions.ts";
import { type Attempt, type AttemptIo, runAttempts } from "./attempts.ts";
import { type CredentialPatterns, credentialPatterns } from "./capture.ts";
import { reasonForError, urlTarget } from "./errors.ts";

/** The I/O a check borrows; tests hand in fakes. */
export interface CheckIo extends AttemptIo {
  readonly fetch: typeof fetch;
}

/** What the HTTP check needs of a monitor; the credentials are sent on every attempt and never kept. */
export type HttpMonitor = Pick<
  Monitor,
  "id" | "timeoutMs" | "retries" | "degradedMs"
> & { readonly config: HttpConfig; readonly credentials?: Credentials };

/** At most this much body is read; the rest of the stream is cancelled. */
export const bodyReadBytes = 1_048_576;

/** With redirects on, the check follows at most this many; the next fails the attempt as too many redirects. */
export const redirectCap = 10;

/** Runs one check of the monitor now: attempts until one succeeds or the retries are spent. */
export function runHttpCheck(
  monitor: HttpMonitor,
  io: CheckIo
): Promise<CheckOutcome> {
  const credentials = credentialPatterns(sentValues(monitor.credentials));
  return runAttempts(
    monitor,
    io,
    () => attemptOnce(monitor, io, credentials),
    monitor.config.captureMode
  );
}

/** One request judged by the success rules, or the error it met. */
async function attemptOnce(
  monitor: HttpMonitor,
  io: CheckIo,
  credentials: CredentialPatterns
): Promise<Attempt> {
  const { config, timeoutMs } = monitor;
  const start = io.now();
  const elapsed = () => Math.min(io.now() - start, timeoutMs);
  let statusCode: number | undefined;
  const progress = { read: 0 };
  try {
    const response = await send(
      new URL(config.url),
      requestInit(config, timeoutMs, monitor.credentials),
      config.followRedirects,
      io.fetch
    );
    statusCode = response.status;
    const body = await readBody(response, progress);
    const responseMs = elapsed();
    const observed = {
      body,
      headers: response.headers,
      responseMs,
      statusCode,
    };
    const verdict = evaluateAssertions(
      config.assertions,
      observed,
      credentials
    );
    return {
      assertion: verdict.ok ? undefined : verdict.assertion,
      bytes: body.byteLength,
      error: undefined,
      params: verdict.ok ? { reason: "ok" } : verdict.params,
      reason: verdict.ok ? "ok" : verdict.reason,
      response: { body, credentials, headers: response.headers },
      responseMs,
      statusCode,
      succeeded: verdict.ok,
    };
  } catch (error) {
    const mapped = reasonForError(
      error,
      urlTarget(config.url, timeoutMs),
      credentials
    );
    return {
      assertion: undefined,
      bytes: progress.read,
      error: mapped.error,
      params: mapped.params,
      reason: mapped.reason,
      response: undefined,
      responseMs: elapsed(),
      statusCode,
      succeeded: false,
    };
  }
}

function requestInit(
  config: HttpConfig,
  timeoutMs: number,
  credentials: Credentials | undefined
): BunFetchRequestInit {
  const bodyless = config.method === "GET" || config.method === "HEAD";
  return {
    body: bodyless ? undefined : config.body,
    headers: requestHeaders(credentials),
    method: config.method,
    // The check follows redirects itself (send), so the cap and the one timeout hold.
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    ...(config.ignoreTlsErrors ? { tls: { rejectUnauthorized: false } } : {}),
  };
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
/** What fetch takes off a request when a redirect leaves the origin (probed on Bun 1.4.2). */
const crossOriginHeaders = ["authorization", "cookie", "proxy-authorization"];
/** The headers that describe a body, dropped with it (Fetch standard, HTTP-redirect fetch). */
const bodyHeaders = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
];

/** Sends the request; with redirects on, follows each one as fetch would, up to the cap, every hop under the attempt's one signal. */
async function send(
  url: URL,
  init: BunFetchRequestInit,
  followRedirects: boolean,
  fetchHop: typeof fetch,
  redirects = 0
): Promise<Response> {
  const response = await fetchHop(url.href, init);
  const location = response.headers.get("location");
  if (
    !(
      followRedirects &&
      location !== null &&
      redirectStatuses.has(response.status)
    )
  ) {
    return response;
  }
  await response.body?.cancel();
  if (redirects === redirectCap) {
    // Bun's own error for the same case, so the reason maps alike.
    throw Object.assign(new Error("The response redirected too many times."), {
      code: "TooManyRedirects",
    });
  }
  const next = new URL(location, url);
  // fetch reads file:, data: and s3: URLs; a target must never redirect the check into those. Bun's code and text, as its follow mode refuses them.
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw Object.assign(
      new TypeError(`UnsupportedRedirectProtocol fetching "${url.href}".`),
      { code: "UnsupportedRedirectProtocol" }
    );
  }
  return send(
    next,
    nextHop(init, response.status, next.origin !== url.origin),
    followRedirects,
    fetchHop,
    redirects + 1
  );
}

/** The request of the next hop: credentials left behind on another origin, and a GET with no body where the status asks for one. */
function nextHop(
  init: BunFetchRequestInit,
  status: number,
  crossOrigin: boolean
): BunFetchRequestInit {
  const headers = new Headers(init.headers);
  if (crossOrigin) {
    for (const name of crossOriginHeaders) {
      headers.delete(name);
    }
  }
  const method = init.method ?? "GET";
  const toGet =
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST");
  if (!toGet) {
    return { ...init, headers };
  }
  for (const name of bodyHeaders) {
    headers.delete(name);
  }
  return { ...init, body: undefined, headers, method: "GET" };
}

/** The custom headers, then the auth field's Authorization, which wins over a custom one. A value the platform refuses fails the attempt with an error that never repeats it: the platform's own message quotes the value. */
function requestHeaders(credentials: Credentials | undefined): Headers {
  try {
    return buildHeaders(credentials);
  } catch {
    // biome-ignore lint/style/useErrorCause: the platform's error quotes the header's value, a credential that must not reach the failure detail
    throw new Error("the platform refused a request header's value");
  }
}

function buildHeaders(credentials: Credentials | undefined): Headers {
  const headers = new Headers();
  for (const { name, value } of credentials?.headers ?? []) {
    headers.append(name, value);
  }
  const auth = credentials?.auth;
  if (auth?.kind === "basic") {
    // RFC 7617: the user and password joined by a colon, in UTF-8, as base64.
    const pair = new TextEncoder().encode(`${auth.user}:${auth.password}`);
    headers.set("authorization", `Basic ${pair.toBase64()}`);
  } else if (auth?.kind === "bearer") {
    headers.set("authorization", `Bearer ${auth.token}`);
  }
  return headers;
}

/** The token or the base64 pair after its scheme, as the platform sent it. */
const schemeValue = /^(?:Basic|Bearer)[\t ]+(.+)$/;

/** Request headers that carry formats and preferences, never credentials, so their values are not masked. */
const standardHeaders = [
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "cache-control",
  "user-agent",
];

/** Every credential value as the request carried it: each custom header's value as the platform sends it, trimmed, but a standard header's; the auth field's token or base64 pair after its scheme; the basic password inside the pair. Headers the platform refuses send nothing. */
function sentValues(credentials: Credentials | undefined): string[] {
  let sent: Headers;
  try {
    sent = buildHeaders(credentials);
  } catch {
    return [];
  }
  for (const name of standardHeaders) {
    sent.delete(name);
  }
  const auth = credentials?.auth;
  if (!auth) {
    return [...sent.values()];
  }
  const credential = sent.get("authorization")?.match(schemeValue)?.[1];
  sent.delete("authorization");
  return [
    ...sent.values(),
    ...(credential ? [credential] : []),
    ...(auth.kind === "basic" ? [auth.password] : []),
  ];
}

/** Reads the body up to the cap and cancels the rest; the timeout signal covers this read too. `progress` keeps the count when the read fails. */
export async function readBody(
  response: Response,
  progress: { read: number },
  cap = bodyReadBytes
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let read = 0;
  // Leaving the loop early cancels the stream.
  for await (const chunk of response.body) {
    chunks.push(chunk);
    read += chunk.byteLength;
    progress.read = Math.min(read, cap);
    if (read >= cap) {
      break;
    }
  }
  const body = new Uint8Array(Math.min(read, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const room = body.byteLength - offset;
    body.set(room < chunk.byteLength ? chunk.subarray(0, room) : chunk, offset);
    offset += chunk.byteLength;
    if (offset >= body.byteLength) {
      break;
    }
  }
  return body;
}
