/**
 * Test support: a small OpenID Connect provider on a local port, so single
 * sign-on is tested against a real HTTP provider, end to end, with the id
 * token signed by a key published at its JWKS address and checked by Better
 * Auth as a real one would be. It signs in whichever person the test names,
 * at once (no login page), and keeps the authorization code's PKCE
 * challenge and nonce. Imported by tests and the e2e harness only.
 */

/** The person the provider signs in next: the claims of their id token. */
export interface OidcPerson {
  /** Any other claims, such as `groups`. */
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly sub: string;
}

export interface OidcProviderFixture {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly discoveryUrl: string;
  readonly issuer: string;
  /** Who the next authorization signs in. */
  readonly signInAs: (person: OidcPerson) => void;
  readonly stop: () => void;
  /** Each token request's form, for a test that reads what the client sent. */
  readonly tokenRequests: URLSearchParams[];
}

interface Grant {
  readonly challenge: string | null;
  readonly nonce: string | null;
  readonly person: OidcPerson;
  readonly redirectUri: string;
}

const textEncoder = new TextEncoder();

function base64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? textEncoder.encode(bytes) : bytes;
  return data.toBase64({ alphabet: "base64url", omitPadding: true });
}

async function sha256(text: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", textEncoder.encode(text))
    )
  );
}

/** Starts the provider; `stop` it when done. */
export async function startOidcProvider(
  options: { readonly clientId?: string; readonly clientSecret?: string } = {}
): Promise<OidcProviderFixture> {
  const clientId = options.clientId ?? "raaqeb-test";
  const clientSecret = options.clientSecret ?? "a-test-client-secret";
  const keys = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const kid = "test-key";
  let next: OidcPerson = {
    email: "someone@example.com",
    emailVerified: true,
    name: "Someone",
    sub: "someone",
  };
  const grants = new Map<string, Grant>();
  const tokenRequests: URLSearchParams[] = [];

  const sign = async (claims: Record<string, unknown>): Promise<string> => {
    const head = base64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const body = base64url(JSON.stringify(claims));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        textEncoder.encode(`${head}.${body}`)
      )
    );
    return `${head}.${body}.${base64url(signature)}`;
  };

  /** The grant the token request names, when its client, redirect and PKCE verifier match. */
  const grantOf = async (
    request: Request,
    form: URLSearchParams
  ): Promise<Grant | "invalid_client" | "invalid_grant"> => {
    const basic = request.headers.get("authorization") ?? "";
    const [sentId, sentSecret] = basic.startsWith("Basic ")
      ? atob(basic.slice(6)).split(":").map(decodeURIComponent)
      : [form.get("client_id"), form.get("client_secret")];
    if (sentId !== clientId || sentSecret !== clientSecret) {
      return "invalid_client";
    }
    const code = form.get("code") ?? "";
    const grant = grants.get(code);
    grants.delete(code);
    const verifier = await sha256(form.get("code_verifier") ?? "");
    const pkce = grant?.challenge === null || grant?.challenge === verifier;
    return grant && grant.redirectUri === form.get("redirect_uri") && pkce
      ? grant
      : "invalid_grant";
  };

  const token = async (request: Request, origin: string) => {
    const form = new URLSearchParams(await request.text());
    tokenRequests.push(form);
    const grant = await grantOf(request, form);
    if (typeof grant === "string") {
      return Response.json(
        { error: grant },
        { status: grant === "invalid_client" ? 401 : 400 }
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = await sign({
      aud: clientId,
      email: grant.person.email,
      email_verified: grant.person.emailVerified,
      exp: now + 300,
      iat: now,
      iss: origin,
      name: grant.person.name,
      sub: grant.person.sub,
      ...(grant.nonce === null ? {} : { nonce: grant.nonce }),
      ...grant.person.claims,
    });
    return Response.json({
      access_token: crypto.randomUUID(),
      expires_in: 300,
      id_token: idToken,
      token_type: "Bearer",
    });
  };

  const server = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      const issuer = url.origin;
      switch (url.pathname) {
        case "/.well-known/openid-configuration":
          return Response.json({
            authorization_endpoint: `${issuer}/authorize`,
            id_token_signing_alg_values_supported: ["RS256"],
            issuer,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`,
          });
        case "/jwks":
          return Response.json({
            keys: [{ ...publicJwk, alg: "RS256", kid, use: "sig" }],
          });
        case "/authorize": {
          const redirectUri = url.searchParams.get("redirect_uri") ?? "";
          if (url.searchParams.get("client_id") !== clientId) {
            return new Response("unknown client", { status: 400 });
          }
          const code = crypto.randomUUID();
          grants.set(code, {
            challenge: url.searchParams.get("code_challenge"),
            nonce: url.searchParams.get("nonce"),
            person: next,
            redirectUri,
          });
          const back = new URL(redirectUri);
          back.searchParams.set("code", code);
          back.searchParams.set("state", url.searchParams.get("state") ?? "");
          back.searchParams.set("iss", issuer);
          return Response.redirect(back.toString(), 302);
        }
        case "/token":
          return await token(request, issuer);
        case "/userinfo":
          return Response.json({
            email: next.email,
            email_verified: next.emailVerified,
            name: next.name,
            sub: next.sub,
            ...next.claims,
          });
        default:
          return new Response("Not Found", { status: 404 });
      }
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const issuer = `http://127.0.0.1:${server.port}`;
  return {
    clientId,
    clientSecret,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    issuer,
    signInAs: (person) => {
      next = person;
    },
    stop: () => {
      server.stop(true);
    },
    tokenRequests,
  };
}
