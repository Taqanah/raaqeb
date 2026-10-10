/**
 * `raaqeb set-address <url>`: stores the public address from the
 * server's shell, so an install whose address refuses every sign-in
 * is reachable again without the general settings page. Runs beside a live
 * server over the same database, as reset-password does; the change counter
 * it moves makes the server read the address again, so no restart is
 * needed. Exit codes follow reset-password: 0 done, 1 refused or a database
 * that did not answer.
 */
import type { Terminal } from "@/server/auth/command.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { savePublicAddress } from "./general.ts";

/** Stores an address the command line already checked is an origin, and answers the exit code. */
export async function setAddressCommand(
  storage: Pick<Storage, "bump" | "pages" | "settings">,
  address: string,
  terminal: Pick<Terminal, "err" | "out">
): Promise<number> {
  const saved = await savePublicAddress(storage, address);
  if (saved.ok) {
    terminal.out(`The public address is now ${address}.`);
    terminal.out(`Sign in at ${address}/sign-in`);
    return 0;
  }
  terminal.err(
    saved.reason === "address_is_page_domain"
      ? "a status page serves this host as its custom domain; the public address needs a host of its own"
      : "the database did not answer and the command stopped; run it again"
  );
  return 1;
}
