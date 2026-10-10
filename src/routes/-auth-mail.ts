/**
 * Whether the install can send auth mail: "forgot password"
 * shows the request form or the reset command by it, and the second step
 * offers an emailed code beside the authenticator app's by it. Signed-out
 * pages ask, so it says only whether an email channel exists. A database
 * that does not answer counts as none. Not a route file: the leading dash
 * keeps it out of the route tree.
 */
import { createServerFn } from "@tanstack/react-start";
import { authEmailChannelOf } from "@/server/auth/mail.ts";

export const hasAuthEmail = createServerFn({ method: "GET" }).handler(
  async ({ context }): Promise<boolean> => {
    if (!context.storage) {
      return false;
    }
    try {
      return (await authEmailChannelOf(context.storage)) !== undefined;
    } catch {
      return false;
    }
  }
);
