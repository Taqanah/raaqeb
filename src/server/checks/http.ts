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
import { inRanges } from "@/server/boot/proxies.ts";
import { userAgent } from "@/server/release/release.ts";
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type { Credentials } from "@/shared/schemas/credentials.ts";
import type { HttpConfig, Monitor } from "@/shared/schemas/monitor.ts";
import { evaluateAssertions } from "./assertions.ts";
import { type Attempt, type AttemptIo, runAttempts } from "./attempts.ts";
import { readBody } from "./body.ts";
import {
  type CredentialPatterns,
  credentialPatterns,
  maskCredentialText,
} from "./capture.ts";
import { certificateDates, datesProblem } from "./client-certificate.ts";
import { reasonForError, urlTarget } from "./errors.ts";
import {
  dropToken,
  type TokenCache,
  type TokenFailure,
  type TokenResult,
  tokenFor,
} from "./oauth2.ts";

/** The I/O a check borrows; tests hand in fakes. */
export interface CheckIo extends AttemptIo {
  readonly fetch: typeof fetch;
  /** The OAuth 2.0 tokens kept in memory between checks; with none, each attempt asks its token endpoint. */
  readonly tokens?: TokenCache;
}

/** What the HTTP check needs of a monitor; the credentials are sent on every attempt and never kept. */
export type HttpMonitor = Pick<
  Monitor,
  "id" | "timeoutMs" | "retries" | "degradedMs"
> & { readonly config: HttpConfig; readonly credentials?: Credentials };

/** With redirects on, the check follows at most this many; the next fails the attempt as too many redirects. */
export const redirectCap = 10;

/**
 * The `proxy` option of a monitor's own proxy: its address, its sealed user
 * name and password as the proxy's Basic authorization, and the install's
 * `NO_PROXY` not applied, since the operator asked for this proxy for this
 * monitor. Nothing for a monitor with none, so the proxy environment decides.
 */
export function proxyOf(
  config: HttpConfig,
  credentials: Credentials | undefined
): Bun.FetchProxyOption | undefined {
  if (config.proxy === undefined) {
    return;
  }
  const auth = credentials?.proxyAuth;
  return {
    // RFC 7617, as the target's own basic auth is built; Bun sends it with the CONNECT or the request.
    ...(auth && {
      headers: {
        "Proxy-Authorization": `Basic ${basicPair(auth.user, auth.password)}`,
      },
    }),
    respectNoProxy: false,
    url: config.proxy,
  };
}

/** Runs one check of the monitor now: attempts until one succeeds or the retries are spent. */
export function runHttpCheck(
  monitor: HttpMonitor,
  io: CheckIo
): Promise<CheckOutcome> {
  const values = sentValues(monitor.credentials);
  return runAttempts(
    monitor,
    io,
    () => attemptOnce(monitor, io, values),
    monitor.config.captureMode
  );
}

/** The attempt a token endpoint's refusal ends in, before the target is called. */
function tokenFailureAttempt(
  failed: TokenFailure,
  credentials: CredentialPatterns,
  responseMs: number
): Attempt {
  return {
    assertion: undefined,
    bytes: 0,
    error: maskCredentialText(failed.error, credentials),
    params: {
      ...(failed.code !== undefined && { code: failed.code }),
      reason: "oauth2_token_failed",
      ...(failed.status !== undefined && { status: failed.status }),
    },
    reason: "oauth2_token_failed",
    response: undefined,
    responseMs,
    statusCode: undefined,
    succeeded: false,
  };
}

/** One request judged by the success rules, or the error it met. */
async function attemptOnce(
  monitor: HttpMonitor,
  io: CheckIo,
  values: readonly string[]
): Promise<Attempt> {
  const { config, timeoutMs } = monitor;
  const start = io.now();
  const elapsed = () => Math.min(io.now() - start, timeoutMs);
  let statusCode: number | undefined;
  const progress = { read: 0 };
  let credentials = credentialPatterns(values);
  const expired = clientCertificateExpiry(config, start);
  if (expired) {
    return expired;
  }
  if (
    (config.caCertificates !== undefined ||
      presentsClientCertificate(monitor)) &&
    viaHttpsProxy(config, process.env)
  ) {
    return tlsProxyAttempt();
  }
  const hop = { carriedCertificate: false, url: new URL(config.url) };
  // Whether the request in flight went through a proxy, judged by its own hop's URL.
  const proxied = () =>
    proxyFor(hop.url, config.proxy, process.env) !== undefined;
  // One signal for the attempt: the token request and the target's answer share its time.
  const signal = AbortSignal.timeout(timeoutMs);
  const grant =
    monitor.credentials?.auth?.kind === "oauth2"
      ? monitor.credentials.auth
      : undefined;
  let granted: Extract<TokenResult, { ok: true }> | undefined;
  try {
    if (grant) {
      const asked = await tokenFor({
        cache: io.tokens,
        fetch: io.fetch,
        grant,
        ignoreTlsErrors: config.ignoreTlsErrors,
        monitorId: monitor.id,
        now: io.now,
        proxy: proxyOf(config, monitor.credentials),
        signal,
      });
      if (!asked.ok) {
        return tokenFailureAttempt(asked, credentials, elapsed());
      }
      granted = asked;
      // The token is a credential from here on: masked wherever the response or an error would repeat it.
      credentials = credentialPatterns([...values, asked.token]);
    }
    const response = await send(
      new URL(config.url),
      requestInit(config, signal, monitor.credentials, granted?.token),
      config.followRedirects,
      io.fetch,
      hop
    );
    statusCode = response.status;
    if (granted?.cached && statusCode === 401) {
      // The target refused a token that may have been revoked: the next attempt asks for another.
      dropToken(io.tokens, monitor.id);
    }
    const body = await readBody(response, progress);
    const responseMs = elapsed();
    // Only a proxy asks for its own sign-in; through one, that answer is the proxy's, whatever the assertions say.
    if (statusCode === 407 && proxied()) {
      return {
        assertion: undefined,
        bytes: body.byteLength,
        error: undefined,
        params: { reason: "proxy_failed", status: statusCode },
        reason: "proxy_failed",
        response: { body, credentials, headers: response.headers },
        responseMs,
        statusCode,
        succeeded: false,
      };
    }
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
      credentials,
      { clientCertificate: hop.carriedCertificate, proxied: proxied() }
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

/** The attempt a custom CA or client certificate beside an https proxy ends in, before any request is sent. */
function tlsProxyAttempt(): Attempt {
  return {
    assertion: undefined,
    bytes: 0,
    error: undefined,
    params: { reason: "tls_proxy_unsupported" },
    reason: "tls_proxy_unsupported",
    response: undefined,
    responseMs: 0,
    statusCode: undefined,
    succeeded: false,
  };
}

const noProxySeparator = /[\s,]+/;
const wildcardPrefix = /^\*?\./;
/** An entry's host and port: `example.test:8080`, `[::1]:8080`; a bare IPv6 address has no port. */
const entryPort = /^(.*[^:]):(\d+)$/;
const brackets = /^\[|\]$/g;

/** Whether `NO_PROXY` exempts the URL as Bun 1.4.4 reads it: `*`; an address range; or the host, or a domain it is under (a leading `.` or `*.` optional), in any case, at the entry's port when it names one. */
function exempt(url: URL, noProxy: string | undefined): boolean {
  const host = url.hostname.replace(brackets, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return (noProxy ?? "")
    .toLowerCase()
    .split(noProxySeparator)
    .filter((entry) => entry !== "")
    .some((entry) => {
      if (entry === "*") {
        return true;
      }
      if (entry.includes("/")) {
        return inRanges([entry])(host);
      }
      const [, named = entry, onPort] = entry.match(entryPort) ?? [];
      const domain = named.replace(brackets, "").replace(wildcardPrefix, "");
      return (
        (onPort === undefined || onPort === port) &&
        (host === domain || host.endsWith(`.${domain}`))
      );
    });
}

/** The proxy a request to the URL goes through: the monitor's own, or else the install's from the environment for the URL's scheme, unless `NO_PROXY` exempts it. Nothing when the request goes direct. */
export function proxyFor(
  url: URL,
  own: string | undefined,
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  if (own !== undefined) {
    return own;
  }
  const names =
    url.protocol === "https:"
      ? ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
      : ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  const proxy = names.map((name) => env[name]).find((value) => value);
  return proxy && !exempt(url, env.NO_PROXY ?? env.no_proxy)
    ? proxy
    : undefined;
}

/** Whether the monitor's requests go through an https proxy: its own, or the install's from the environment when the target is one the proxy applies to. */
export function viaHttpsProxy(
  config: HttpConfig,
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return (
    proxyFor(new URL(config.url), config.proxy, env)
      ?.toLowerCase()
      .startsWith("https:") === true
  );
}

/** Whether the request carries a client certificate: one is configured and its key opened with the credentials. */
function presentsClientCertificate(monitor: HttpMonitor): boolean {
  return (
    monitor.config.clientCertificate !== undefined &&
    monitor.credentials?.clientKey !== undefined
  );
}

/** The attempt a client certificate outside its dates ends in, before any request is sent; nothing for one inside them, or for a monitor with none. */
function clientCertificateExpiry(
  config: HttpConfig,
  now: number
): Attempt | undefined {
  const dates =
    config.clientCertificate === undefined
      ? undefined
      : certificateDates(config.clientCertificate);
  const code = dates && datesProblem(dates, now);
  if (!code) {
    return;
  }
  return {
    assertion: undefined,
    bytes: 0,
    error: undefined,
    params: { code, reason: "client_certificate_expired" },
    reason: "client_certificate_expired",
    response: undefined,
    responseMs: 0,
    statusCode: undefined,
    succeeded: false,
  };
}

/** The `tls` option: the monitor's own CA bundle, which replaces the well-known ones, its client certificate and key with the key's passphrase, and, when the monitor ignores TLS errors, no verification of the server. Nothing for a monitor with none of them. */
function tlsOf(
  config: HttpConfig,
  credentials: Credentials | undefined
): BunFetchRequestInit["tls"] {
  const key = credentials?.clientKey;
  const present = config.clientCertificate !== undefined && key !== undefined;
  if (!(config.ignoreTlsErrors || config.caCertificates || present)) {
    return;
  }
  return {
    ...(config.caCertificates && { ca: config.caCertificates }),
    ...(present && {
      cert: config.clientCertificate,
      key: key.key,
      ...(key.passphrase !== undefined && { passphrase: key.passphrase }),
    }),
    ...(config.ignoreTlsErrors && { rejectUnauthorized: false }),
  };
}

function requestInit(
  config: HttpConfig,
  signal: AbortSignal,
  credentials: Credentials | undefined,
  token: string | undefined
): BunFetchRequestInit {
  const bodyless = config.method === "GET" || config.method === "HEAD";
  return {
    body: bodyless ? undefined : config.body,
    headers: requestHeaders(credentials, token),
    method: config.method,
    // The monitor's own proxy; without one the option is left out, so Bun reads the proxy environment at each request.
    proxy: proxyOf(config, credentials),
    // The check follows redirects itself (send), so the cap and the one timeout hold.
    redirect: "manual",
    signal,
    tls: tlsOf(config, credentials),
  };
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
/** What fetch takes off a request when a redirect leaves the origin (probed on Bun 1.4.3). */
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
  hop: { carriedCertificate: boolean; url: URL },
  redirects = 0
): Promise<Response> {
  // Whether the request in flight presents the client certificate, and where it goes, for the reading of how it failed.
  hop.carriedCertificate = init.tls?.cert !== undefined;
  hop.url = url;
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
    hop,
    redirects + 1
  );
}

/** The `tls` of a hop to another origin: the monitor's CA, client certificate, key and passphrase were configured for the first one, so they stay behind and the system roots verify this one; only the choice to ignore TLS errors, made for every address, goes on. */
function tlsAcrossOrigins(
  tls: BunFetchRequestInit["tls"]
): BunFetchRequestInit["tls"] {
  return tls?.rejectUnauthorized === false
    ? { rejectUnauthorized: false }
    : undefined;
}

/** The request of the next hop: credentials left behind on another origin, and a GET with no body where the status asks for one. */
function nextHop(
  from: BunFetchRequestInit,
  status: number,
  crossOrigin: boolean
): BunFetchRequestInit {
  const headers = new Headers(from.headers);
  if (crossOrigin) {
    for (const name of crossOriginHeaders) {
      headers.delete(name);
    }
  }
  const init = crossOrigin
    ? { ...from, tls: tlsAcrossOrigins(from.tls) }
    : from;
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
function requestHeaders(
  credentials: Credentials | undefined,
  token?: string
): Headers {
  try {
    const headers = buildHeaders(credentials, token);
    // Without this Bun sends its own, which many firewalls refuse; a custom header wins.
    if (!headers.has("user-agent")) {
      headers.set("user-agent", userAgent);
    }
    return headers;
  } catch {
    // biome-ignore lint/style/useErrorCause: the platform's error quotes the header's value, a credential that must not reach the failure detail
    throw new Error("the platform refused a request header's value");
  }
}

/** The headers a request carries: the custom ones, then the auth's Authorization, which wins. An OAuth 2.0 grant's is the token it was given, or none while the token is not yet known. */
function buildHeaders(
  credentials: Credentials | undefined,
  token?: string
): Headers {
  const headers = new Headers();
  for (const { name, value } of credentials?.headers ?? []) {
    headers.append(name, value);
  }
  const auth = credentials?.auth;
  if (auth?.kind === "basic") {
    headers.set(
      "authorization",
      `Basic ${basicPair(auth.user, auth.password)}`
    );
  } else if (auth?.kind === "bearer") {
    headers.set("authorization", `Bearer ${auth.token}`);
  } else if (auth?.kind === "oauth2" && token !== undefined) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

/** RFC 7617: the user and password joined by a colon, in UTF-8, as base64. */
function basicPair(user: string, password: string): string {
  return new TextEncoder().encode(`${user}:${password}`).toBase64();
}

/** The token or the base64 pair after its scheme, as the platform sent it. */
const schemeValue = /^(?:Basic|Bearer)[\t ]+(.+)$/;

/** An OAuth 2.0 client ID shorter than this is not masked: it would redact ordinary words. */
const minMaskedIdLength = 8;

/** Request headers that carry formats and preferences, never credentials, so their values are not masked. */
const standardHeaders = [
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "cache-control",
  "user-agent",
];

/** Every credential value as the request carried it: the proxy's base64 pair and password; each custom header's value as the platform sends it, trimmed, but a standard header's; the auth field's token or base64 pair after its scheme; the basic password inside the pair. Headers the platform refuses send nothing. */
function sentValues(credentials: Credentials | undefined): string[] {
  const proxy = credentials?.proxyAuth;
  return [
    ...(proxy ? [basicPair(proxy.user, proxy.password), proxy.password] : []),
    ...requestValues(credentials),
  ];
}

/** The credential values the request's own headers carry. */
function requestValues(credentials: Credentials | undefined): string[] {
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
    // What an OAuth 2.0 grant sends to its token endpoint, masked wherever a check would write text: the client secret, as typed and form-encoded, and the client ID.
    ...(auth.kind === "oauth2"
      ? [
          auth.clientSecret,
          encodeURIComponent(auth.clientSecret),
          // A short ID would redact ordinary words.
          ...(auth.clientId.length >= minMaskedIdLength ? [auth.clientId] : []),
        ]
      : []),
  ];
}
