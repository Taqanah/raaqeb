/**
 * Where a subscriber's webhook may point: anyone can
 * type the address, so Raaqeb posts only to https on the public internet.
 * A name is resolved and every address it answers must be outside the
 * loopback, private, link-local, shared, multicast, documentation and
 * reserved ranges; the check runs at sign-up and again before each POST.
 * The operator's own channels are not held to it.
 */
import { inRanges } from "@/server/boot/proxies.ts";

/** Resolves a host name to its addresses; throws when it cannot. */
export type HostLookup = (hostname: string) => Promise<readonly string[]>;

/** A lookup that has not answered by then refuses the address, so a slow name server never holds a delivery's slot. */
export const lookupTimeoutMs = 5000;

/** The system's resolver through Bun, both families. */
export const lookupHost: HostLookup = async (hostname) =>
  (await Bun.dns.lookup(hostname)).map((answer) => answer.address);

/**
 * Every range a visitor may not name (IANA's special-purpose registries):
 * this network, private, shared, loopback, link-local, protocol assignments,
 * documentation, 6to4 relays, benchmarking, multicast, reserved and
 * broadcast; in IPv6 the unspecified, loopback and IPv4-compatible
 * addresses, IPv4-translated ones, NAT64,
 * discard, protocol assignments (Teredo among them), documentation, 6to4,
 * unique local, link-local and multicast. IPv4 mapped into IPv6 is read as
 * IPv4, so `::ffff:10.0.0.1` is private.
 */
const blocked = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/96",
  "::ffff:0:0:0/96",
  "64:ff9b::/96",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

const inBlocked = inRanges(blocked);

/** The URL keeps an IPv6 address in brackets. */
const bracketed = /^\[(.*)\]$/;

/** An address in either family, what the range matcher reads; text that is none never matches it. */
const anyAddress = inRanges(["::/0"]);

/** Whether an address is on the public internet: outside every range a visitor may not name. */
export function isInternetAddress(address: string): boolean {
  return anyAddress(address) && !inBlocked(address);
}

/** The answer, or a rejection once `ms` passed; the timer goes with the answer. */
async function withinTime<T>(answer: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the lookup did not answer")),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a subscriber's webhook may be posted to: an https URL whose host is, or resolves only to, internet addresses. A name that does not resolve is refused. Never throws. */
export async function webhookReachable(
  url: string,
  lookup: HostLookup,
  timeoutMs: number = lookupTimeoutMs
): Promise<boolean> {
  if (!URL.canParse(url)) {
    return false;
  }
  const { hostname, protocol } = new URL(url);
  if (protocol !== "https:") {
    return false;
  }
  const host = hostname.replace(bracketed, "$1");
  if (anyAddress(host)) {
    return isInternetAddress(host);
  }
  try {
    const addresses = await withinTime(lookup(host), timeoutMs);
    return addresses.length > 0 && addresses.every(isInternetAddress);
  } catch {
    // A name that does not resolve reaches nothing Raaqeb may post to.
    return false;
  }
}
