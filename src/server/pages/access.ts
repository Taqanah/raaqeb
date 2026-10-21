/**
 * Page access (CONTEXT.md "Page access", "Private page", "Page pass"): who
 * may see a published status page. A public page is everyone's. A private
 * one lets in a signed-in user of this install whatever its mode, a visitor
 * from one of its allowed addresses in password and addresses mode, and a
 * visitor holding its page pass in password mode: the cookie a right
 * password earns, sealed with the install key, naming the page, a digest of
 * the password's hash and when it ends, so a new password ends every pass.
 * Anyone else meets the access page. Wrong tries at the password are counted
 * per client network in a table of bounded size, so no stranger grows it.
 */
import { decrypt, encrypt, type InstallKey } from "@/server/boot/installkey.ts";
import {
  clientNetwork,
  inRanges,
  isProxyEntry,
} from "@/server/boot/proxies.ts";
import { passwordDigest as storedDigest } from "@/server/storage/pages.ts";
import type { PageAccess } from "@/shared/schemas/page.ts";

/** How long a page pass lasts. */
export const passLifetimeMs = 30 * 24 * 60 * 60 * 1000;

/** What a request shows of the visitor: the client address the entry resolved behind the trusted proxies, the Cookie header, and whether it carries a live session of this install, read only when asked. */
export interface Visitor {
  readonly client: string | undefined;
  readonly cookie: string | null;
  readonly signedIn: () => Promise<boolean>;
}

/** The page whose access is judged: its id and its access. */
export interface GuardedPage {
  readonly access: PageAccess;
  readonly id: string;
}

/** The digest of a page password's stored hash that a page pass names, made where the page's row is read. */
export const passwordDigest: (hash: string) => string = storedDigest;

/** The name of the cookie that holds a page's pass. */
export function passCookieName(pageId: string): string {
  return `raaqeb.pass.${pageId}`;
}

/** A new page pass for the page as it is now, ending `passLifetimeMs` after `now`: the cookie's value. */
export function issuePass(
  key: InstallKey,
  page: GuardedPage,
  now: number
): Promise<string> {
  return encrypt(
    key,
    `${page.id} ${page.access.passwordDigest ?? ""} ${now + passLifetimeMs}`
  );
}

/** The Set-Cookie header that hands a visitor a page pass: HttpOnly, SameSite=Lax, for the whole host, Secure over https. */
export function passCookie(
  pageId: string,
  value: string,
  secure: boolean
): string {
  return `${passCookieName(pageId)}=${value}; Path=/; Max-Age=${passLifetimeMs / 1000}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The value of one cookie in a Cookie header, or nothing. */
function cookieValue(header: string | null, name: string): string | undefined {
  for (const pair of (header ?? "").split(";")) {
    const [key = "", ...value] = pair.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
}

/** Whether the visitor's cookie holds a pass to the page as it is now: sealed with this key, naming the page and its password's digest, not yet ended. */
async function holdsPass(
  page: GuardedPage,
  cookie: string | null,
  key: InstallKey,
  now: number
): Promise<boolean> {
  const value = cookieValue(cookie, passCookieName(page.id));
  if (!(value && page.access.passwordDigest)) {
    return false;
  }
  const opened = await decrypt(key, value);
  const [id, digest, ends] = opened?.split(" ") ?? [];
  return (
    id === page.id &&
    digest === page.access.passwordDigest &&
    Number(ends) > now
  );
}

/** Whether the visitor may see the page: always for a public page; for a private one, by its allowed addresses, its page pass or a live session. */
export async function admits(
  page: GuardedPage,
  visitor: Visitor,
  key: InstallKey | undefined,
  now: number
): Promise<boolean> {
  const { access } = page;
  if (access.mode === "public") {
    return true;
  }
  const byAddress = access.mode === "password" || access.mode === "addresses";
  if (
    byAddress &&
    visitor.client !== undefined &&
    inRanges(access.addresses)(visitor.client)
  ) {
    return true;
  }
  if (
    access.mode === "password" &&
    key &&
    (await holdsPass(page, visitor.cookie, key, now))
  ) {
    return true;
  }
  return await visitor.signedIn();
}

/** The first allowed address that is neither an IP address nor a CIDR range, or nothing when all are. */
export function refusedAddress(
  addresses: readonly string[]
): string | undefined {
  return addresses.find((entry) => !isProxyEntry(entry));
}

/** Attempts at page passwords: so many wrong ones per client network in a period. A network is an IPv4 address alone, since an office's NAT is one address and a /24 would let one host lock out its neighbours, or an IPv6 site's /48, so the 65,536 /64s one site holds share one share. */
export interface AttemptLimiter {
  /** Gives back the try taken at `at`: the right password's, which costs the client nothing. */
  readonly refund: (client: string | undefined, at: number) => void;
  /** How long the client waits, in milliseconds, until its oldest try leaves the period; nothing while it has room. */
  readonly retryAfter: (client: string | undefined, now: number) => number;
  /** Takes one attempt for the client at `now`; false once it has had its share. */
  readonly take: (client: string | undefined, now: number) => boolean;
}

/** Ten attempts per client network in ten minutes. */
export const attemptsPerClient = 10;
export const attemptPeriodMs = 10 * 60 * 1000;
/** The most clients the table holds: past it the client that tried longest ago is forgotten, so a flood of new clients locks no one out; the one-at-a-time verification still bounds how fast anyone guesses. */
export const attemptClientsMax = 10_000;

export function createAttemptLimiter(
  limit: number = attemptsPerClient,
  periodMs: number = attemptPeriodMs,
  capacity: number = attemptClientsMax
): AttemptLimiter {
  /** Each client's tries inside the period, oldest first; the Map's first key is the client that tried longest ago. */
  const taken = new Map<string, number[]>();
  // A request with no known client shares one share.
  const keyOf = (client: string | undefined) =>
    client === undefined ? "" : clientNetwork(client, 48);
  const recentOf = (key: string, now: number) =>
    (taken.get(key) ?? []).filter((at) => now - at < periodMs);
  return {
    refund: (client, at) => {
      const key = keyOf(client);
      const times = taken.get(key) ?? [];
      const index = times.lastIndexOf(at);
      if (index >= 0) {
        taken.set(key, times.toSpliced(index, 1));
      }
    },
    retryAfter: (client, now) => {
      const recent = recentOf(keyOf(client), now);
      const [oldest] = recent;
      return recent.length < limit || oldest === undefined
        ? 0
        : oldest + periodMs - now;
    },
    take: (client, now) => {
      const key = keyOf(client);
      const recent = recentOf(key, now);
      // Moved to the end, the client is now the one that tried last.
      taken.delete(key);
      if (recent.length >= limit) {
        taken.set(key, recent);
        return false;
      }
      taken.set(key, [...recent, now]);
      for (const oldest of taken.keys()) {
        if (taken.size <= capacity) {
          break;
        }
        taken.delete(oldest);
      }
      return true;
    },
  };
}
