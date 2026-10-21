/**
 * What the signed-out sign-in and invitation pages offer of single sign-on:
 * the identity provider's button and whether the password is an owner's
 * alone. A stranger's read, so it says only that. Not a route file: the
 * leading dash keeps it out of the route tree.
 */
import { createServerFn } from "@tanstack/react-start";
import { readSsoOffer } from "@/server/auth/sso.ts";
import type { SsoOffer } from "@/shared/schemas/sso.ts";

export const readSsoOfferFn = createServerFn({ method: "GET" }).handler(
  ({ context }): Promise<SsoOffer | undefined> => readSsoOffer(context.storage)
);
