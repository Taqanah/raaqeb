/**
 * An HTTP monitor's OAuth 2.0 client credentials grant (CONTEXT.md "Client
 * credentials"): the token request to the monitor's token endpoint, and the
 * token kept in memory per monitor until shortly before it expires. It does
 * no I/O beyond the injected `fetch`, takes `now` as a parameter, never throws
 * for a token endpoint's answer, and never writes the token or the client
 * secret anywhere: not into a failure's text, not to a log, not to a capture.
 */
import type { Credentials } from "@/shared/schemas/credentials.ts";
import { readBody } from "./body.ts";
import { codeOf } from "./errors.ts";

/** The grant an HTTP monitor's credentials hold. */
export type OAuth2Grant = Extract<
  NonNullable<Credentials["auth"]>,
  { kind: "oauth2" }
>;

/** At most this much of a token endpoint's answer is read. */
export const tokenBodyMaxBytes = 65_536;

/** How long a token lives when its endpoint names no lifetime. */
export const tokenLifetimeDefaultMs = 300_000;

/** The longest a token is kept, whatever its endpoint says. */
export const tokenLifetimeMaxMs = 86_400_000;

/** A token is renewed this long before it expires, or a tenth of its lifetime when that is shorter. */
export const tokenRefreshMarginMs = 60_000;

/** The longest access token a header carries. */
const tokenMaxLength = 8192;

/** An access token is printable ASCII, so it is one header value. */
const tokenShape = /^[\x21-\x7E]+$/;

/** The `error` codes a failure may name: RFC 6749 section 5.2's, and the common ones other servers add. Anything else an endpoint writes, a secret it echoes included, is left out. */
const errorCodes: ReadonlySet<string> = new Set([
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_grant_type",
]);

/** The tokens in memory, by monitor, and the requests in flight. */
export interface TokenCache {
  readonly pending: Map<string, Promise<TokenResult>>;
  readonly tokens: Map<
    string,
    {
      /** The grant the token was asked for, as a digest, so an edited grant is a new token. */
      readonly grant: string;
      /** When the token is asked for again: its expiry less the refresh margin. */
      readonly renewAt: number;
      readonly token: string;
    }
  >;
}

export function createTokenCache(): TokenCache {
  return { pending: new Map(), tokens: new Map() };
}

/** Why the endpoint gave no token. */
export interface TokenFailure {
  /** The `error` the endpoint named, when it named one that reads as a code. */
  readonly code: string | undefined;
  /** A sentence for the failure detail; holds no secret. */
  readonly error: string;
  readonly ok: false;
  /** The endpoint's HTTP status, when it answered. */
  readonly status: number | undefined;
}

/** A token, from the cache or the endpoint, or why the endpoint gave none. */
export type TokenResult =
  | { readonly cached: boolean; readonly ok: true; readonly token: string }
  | TokenFailure;

export interface TokenRequest {
  readonly cache: TokenCache | undefined;
  readonly fetch: typeof fetch;
  readonly grant: OAuth2Grant;
  readonly monitorId: string;
  readonly now: () => number;
  readonly proxy?: Bun.FetchProxyOption | undefined;
  readonly signal: AbortSignal;
  /** The `tls` the token request is made with: the target's own on its origin, what a redirect keeps elsewhere. */
  readonly tls?: BunFetchRequestInit["tls"];
}

/** The grant as a digest: what an edit that changes any part of it changes. */
function digestOf(grant: OAuth2Grant): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        grant.tokenUrl,
        grant.clientId,
        grant.clientSecret,
        grant.scope,
        grant.audience,
        grant.method,
      ])
    )
    .digest("hex");
}

function failure(
  status: number | undefined,
  code: string | undefined,
  error: string
): TokenFailure {
  return { code, error, ok: false, status };
}

/** The lifetime an answer names, in milliseconds: its `expires_in` seconds, a number or a number in text, else the default; never more than the maximum. */
function lifetimeOf(expiresIn: unknown): number {
  const seconds =
    typeof expiresIn === "string" && expiresIn.trim() !== ""
      ? Number(expiresIn)
      : expiresIn;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return tokenLifetimeDefaultMs;
  }
  return Math.min(seconds * 1000, tokenLifetimeMaxMs);
}

/** The token and its lifetime in an answer's JSON, or nothing when it holds no usable bearer token. */
function grantedBy(
  json: unknown
): { lifetimeMs: number; token: string } | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return;
  }
  const answer = json as Record<string, unknown>;
  const {
    access_token: token,
    expires_in: expiresIn,
    token_type: type,
  } = answer;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > tokenMaxLength ||
    !tokenShape.test(token) ||
    (type !== undefined &&
      !(typeof type === "string" && type.toLowerCase() === "bearer"))
  ) {
    return;
  }
  return { lifetimeMs: lifetimeOf(expiresIn), token };
}

/** The `error` code of a refusal's JSON body, when it is one of the codes allowed. */
function codeIn(text: string): string | undefined {
  try {
    const json: unknown = JSON.parse(text);
    if (typeof json === "object" && json !== null && "error" in json) {
      const { error } = json;
      return typeof error === "string" && errorCodes.has(error)
        ? error
        : undefined;
    }
  } catch {
    // Not JSON: a refusal with no code.
  }
}

/** The one token request: the grant's own, asked of its endpoint under the attempt's signal. */
async function ask(
  request: TokenRequest
): Promise<
  | { readonly ok: true; readonly lifetimeMs: number; readonly token: string }
  | TokenFailure
> {
  const { grant } = request;
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (grant.scope !== undefined) {
    body.set("scope", grant.scope);
  }
  if (grant.audience !== undefined) {
    body.set("audience", grant.audience);
  }
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (grant.method === "basic") {
    // RFC 6749 section 2.3.1: the ID and the secret form-encoded, then joined by a colon in Basic.
    const pair = new TextEncoder().encode(
      `${encodeURIComponent(grant.clientId)}:${encodeURIComponent(grant.clientSecret)}`
    );
    headers.set("authorization", `Basic ${pair.toBase64()}`);
  } else {
    body.set("client_id", grant.clientId);
    body.set("client_secret", grant.clientSecret);
  }
  let response: Response;
  try {
    response = await request.fetch(grant.tokenUrl, {
      body: body.toString(),
      headers,
      method: "POST",
      proxy: request.proxy,
      // A redirect would carry the secret to another address.
      redirect: "manual",
      signal: request.signal,
      tls: request.tls,
    });
  } catch (error) {
    if (request.signal.aborted) {
      // The attempt's own time ran out: the check reports that, not a token failure.
      throw error;
    }
    return failure(
      undefined,
      undefined,
      `the token endpoint could not be reached (${codeOf(error) ?? "error"})`
    );
  }
  const text = new TextDecoder().decode(
    await readBody(response, { read: 0 }, tokenBodyMaxBytes)
  );
  const { status } = response;
  if (status < 200 || status > 299) {
    const code = codeIn(text);
    return failure(
      status,
      code,
      `the token endpoint answered ${status}${code ? ` ${code}` : ""}`
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // An answer that is not JSON holds no token.
  }
  const granted = grantedBy(json);
  return granted
    ? { ok: true, ...granted }
    : failure(
        status,
        undefined,
        `the token endpoint answered ${status} with no usable access token`
      );
}

/** The monitor's token: from memory while it has more than its refresh margin left, else from the token endpoint. An attempt's timeout is thrown, not answered. */
export function tokenFor(request: TokenRequest): Promise<TokenResult> {
  const { cache, grant, monitorId } = request;
  // The moment it is asked for: a token's life runs from here, not from when a slow answer arrives.
  const asking = request.now();
  if (!cache) {
    return ask(request).then((asked) =>
      asked.ok ? { cached: false, ok: true, token: asked.token } : asked
    );
  }
  // Every read sweeps the tokens past their renewal, so a deleted monitor's does not stay.
  for (const [id, entry] of cache.tokens) {
    if (entry.renewAt <= asking) {
      cache.tokens.delete(id);
    }
  }
  const digest = digestOf(grant);
  const kept = cache.tokens.get(monitorId);
  if (kept && kept.grant === digest) {
    return Promise.resolve({ cached: true, ok: true, token: kept.token });
  }
  const key = `${monitorId}:${digest}`;
  const flying = cache.pending.get(key);
  if (flying !== undefined) {
    return flying;
  }
  const pending = ask(request)
    .then((asked): TokenResult => {
      if (!asked.ok) {
        return asked;
      }
      if (asked.lifetimeMs > 0) {
        const margin = Math.min(tokenRefreshMarginMs, asked.lifetimeMs / 10);
        cache.tokens.set(monitorId, {
          grant: digest,
          renewAt: asking + asked.lifetimeMs - margin,
          token: asked.token,
        });
      }
      return { cached: false, ok: true, token: asked.token };
    })
    .finally(() => {
      cache.pending.delete(key);
    });
  cache.pending.set(key, pending);
  return pending;
}

/** Forgets the monitor's token, so the next attempt asks the endpoint again. */
export function dropToken(
  cache: TokenCache | undefined,
  monitorId: string
): void {
  cache?.tokens.delete(monitorId);
}
