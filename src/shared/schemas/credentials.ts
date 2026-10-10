/**
 * A monitor's credentials: an HTTP monitor's basic auth or
 * bearer token and custom request headers, or a database monitor's
 * connection URL. Stored as one ciphertext under the install key,
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
    ])
    .optional(),
  headers: z
    .array(z.object({ name: headerName, value: headerValue }))
    .max(headersMax)
    .superRefine(namedOnce)
    .default([]),
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
    ])
    .optional(),
  headers: z
    .array(z.object({ name: headerName, value: headerValue.optional() }))
    .max(headersMax)
    .superRefine(namedOnce)
    .default([]),
  /** Left out keeps the stored one. */
  url: connectionUrl.optional(),
});
export type CredentialsInput = z.infer<typeof credentialsInputSchema>;

/** What the edit form reads of the stored credentials: the kind, the user name and the header names, never a secret. */
export interface CredentialsView {
  readonly auth:
    | { readonly kind: "basic"; readonly user: string }
    | { readonly kind: "bearer" }
    | undefined;
  readonly headers: readonly { readonly name: string }[];
  /** Whether a connection URL is stored; never the URL. */
  readonly url: boolean;
}

export const noCredentials: CredentialsView = {
  auth: undefined,
  headers: [],
  url: false,
};
