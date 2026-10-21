/**
 * A monitor's credentials: an HTTP monitor's basic auth, bearer token or
 * OAuth 2.0 client credentials, custom request headers, its client certificate's private key
 * and passphrase and its own proxy's user name and password, or a database
 * monitor's connection URL. Stored as one ciphertext under the install key,
 * never in the monitor's config, never sent back to the browser: the edit
 * form reads the names only, and whether a URL is stored, and a secret
 * value the form leaves out keeps the stored one.
 */
import { z } from "zod";

export const headersMax = 20;
/** Room for a cloud provider's URL, and a bound on the ciphertext. */
export const connectionUrlMaxLength = 2048;
const headerValueMaxLength = 8192;
const secretMaxLength = 8192;
const userMaxLength = 255;

/** A header name as RFC 9110 spells a token. */
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** One line of Latin-1: a line break would end the header early, and the platform refuses a code point above U+00FF, naming the value in its error. */
const headerText = /^[\t\x20-\x7E\x80-\xFF]*$/;

/** At least one character that is not a space. */
const someText = /\S/;

const headerName = z.string().regex(headerNamePattern);
const headerValue = z
  .string()
  .max(headerValueMaxLength)
  .refine((value) => headerText.test(value));
// A colon ends the user name on the wire (RFC 7617).
const user = z
  .string()
  .max(userMaxLength)
  .regex(someText)
  .refine((value) => !value.includes(":"));
const secret = z.string().max(secretMaxLength);
/** An OAuth 2.0 token endpoint's address. */
export const tokenUrlMaxLength = 2048;
const oauthTextMaxLength = 1024;
const clientIdMaxLength = 255;

/** How the client authenticates to the token endpoint: HTTP basic (RFC 6749 section 2.3.1's first choice) or its id and secret in the request body. */
export const oauthMethods = ["basic", "body"] as const;
export const oauthMethodSchema = z.enum(oauthMethods);
export type OAuthMethod = z.infer<typeof oauthMethodSchema>;

/** The token endpoint: an http or https address with no user name or password in it. */
const tokenUrl = z
  .url({ protocol: /^https?$/ })
  .max(tokenUrlMaxLength)
  .refine((url) => {
    if (!URL.canParse(url)) {
      return true;
    }
    const { password, username } = new URL(url);
    return username === "" && password === "";
  });
/** What of an OAuth 2.0 grant is not a secret. */
const oauthFields = {
  audience: z.string().trim().min(1).max(oauthTextMaxLength).optional(),
  clientId: z.string().trim().min(1).max(clientIdMaxLength),
  method: oauthMethodSchema.default("basic"),
  scope: z.string().trim().min(1).max(oauthTextMaxLength).optional(),
  tokenUrl,
};
/** A private key in PEM, encrypted or not; the key's own parsing is the server's. */
const privateKeyPattern = /^-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const privateKey = secret.regex(privateKeyPattern);
const connectionUrl = z.string().trim().min(1).max(connectionUrlMaxLength);
/** A bearer token travels as a header value. */
const token = secret.min(1).refine((value) => headerText.test(value));

/** Each header name once, whatever its case, so a kept value is found by its name; the repeat is named where it was typed. */
function namedOnce(
  headers: readonly { readonly name: string }[],
  context: z.core.$RefinementCtx
): void {
  const seen = new Set<string>();
  for (const [index, header] of headers.entries()) {
    const name = header.name.toLowerCase();
    if (seen.has(name)) {
      context.addIssue({
        code: "custom",
        message: "a header is named once",
        path: [index, "name"],
      });
    }
    seen.add(name);
  }
}

/** What the ciphertext holds. */
export const credentialsSchema = z.object({
  auth: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("basic"), password: secret, user }),
      z.object({ kind: z.literal("bearer"), token }),
      z.object({
        ...oauthFields,
        clientSecret: secret.min(1),
        kind: z.literal("oauth2"),
      }),
    ])
    .optional(),
  /** The private key of the HTTP monitor's client certificate, and the passphrase that opens it when it is encrypted; the certificate is in the monitor's config. */
  clientKey: z
    .object({ key: privateKey, passphrase: secret.optional() })
    .optional(),
  headers: z
    .array(z.object({ name: headerName, value: headerValue }))
    .max(headersMax)
    .superRefine(namedOnce)
    .default([]),
  /** The user name and password the HTTP monitor's own proxy asks for; the proxy's address is in the monitor's config. */
  proxyAuth: z.object({ password: secret, user }).optional(),
  /** A database monitor's connection URL, its password inside it; whether it fits the check type is the monitor's rule (monitor.ts). */
  url: connectionUrl.optional(),
});
export type Credentials = z.infer<typeof credentialsSchema>;

/** What the form posts: a secret value left out keeps the stored one. */
export const credentialsInputSchema = z.object({
  auth: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("basic"),
        password: secret.optional(),
        user,
      }),
      z.object({ kind: z.literal("bearer"), token: token.optional() }),
      z.object({
        ...oauthFields,
        clientSecret: secret.min(1).optional(),
        kind: z.literal("oauth2"),
      }),
    ])
    .optional(),
  /** The client certificate's key and passphrase: a key left out keeps the stored one, and with it its passphrase unless a new one is typed; a key typed replaces both. */
  clientKey: z
    .object({ key: privateKey.optional(), passphrase: secret.optional() })
    .optional(),
  headers: z
    .array(z.object({ name: headerName, value: headerValue.optional() }))
    .max(headersMax)
    .superRefine(namedOnce)
    .default([]),
  /** The proxy's user name and password; a password left out keeps the stored one. */
  proxyAuth: z.object({ password: secret.optional(), user }).optional(),
  /** Left out keeps the stored one. */
  url: connectionUrl.optional(),
});
export type CredentialsInput = z.infer<typeof credentialsInputSchema>;

/** What the edit form reads of the stored credentials: the kind, the user name and the header names, never a secret. */
export interface CredentialsView {
  readonly auth:
    | { readonly kind: "basic"; readonly user: string }
    | { readonly kind: "bearer" }
    | {
        readonly audience?: string | undefined;
        readonly clientId: string;
        readonly kind: "oauth2";
        readonly method: OAuthMethod;
        readonly scope?: string | undefined;
        readonly tokenUrl: string;
      }
    | undefined;
  /** Whether a client certificate's private key is stored, set only when it is; never the key or its passphrase. */
  readonly clientKey?: true;
  readonly headers: readonly { readonly name: string }[];
  /** The user name the proxy is signed in with; never its password. */
  readonly proxyUser?: string | undefined;
  /** Whether a connection URL is stored; never the URL. */
  readonly url: boolean;
}

export const noCredentials: CredentialsView = {
  auth: undefined,
  headers: [],
  url: false,
};
