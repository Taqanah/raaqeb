/**
 * The public address's shape (CONTEXT.md "Public address"): one origin,
 * scheme and host with an optional port, no path, no trailing slash. Shared
 * by the setting, the onboarding screen and the settings form.
 */
import { z } from "zod";

/** Accepts `https://status.raaqeb.dev` or `http://localhost:3000`; refuses a path, a query or a bare host. */
export const publicAddressSchema = z
  .string()
  .refine((value) => isOrigin(value), "an origin: scheme and host only");

/**
 * True when a typed public address would move sign-in away from where the
 * browser is: a valid origin, not the stored one, and not the page's own.
 * Auth origin checks follow the stored address, so saving it ends sign-out
 * and sign-in here.
 */
export function movesSignInAway(
  typed: string,
  stored: string,
  here: string
): boolean {
  const address = typed.trim();
  return isOrigin(address) && address !== stored && address !== here;
}

/** True when the text is exactly the origin of a valid http or https URL. */
export function isOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // The serialised origin is lower-case with no path, so a text equal to it is one.
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.origin === value
  );
}
