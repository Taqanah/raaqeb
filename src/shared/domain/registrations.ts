/**
 * The domain registration's pure rules (CONTEXT.md "Domain registration"):
 * which host a monitor's registration is read for, the names a registry is
 * asked for it, and when the registration is expiring. No I/O; `now` is a
 * parameter.
 */
import type { MonitorConfig } from "@/shared/schemas/monitor.ts";
import {
  type DomainRegistration,
  domainExpiryWarningDays,
} from "@/shared/schemas/registration.ts";

/** TLDs set aside for special use (RFC 2606, RFC 6761, RFC 6762, RFC 7686, RFC 9476, ICANN's .internal): no registry holds a name under one. */
const specialUse = new Set([
  "alt",
  "arpa",
  "example",
  "internal",
  "invalid",
  "local",
  "localhost",
  "onion",
  "test",
]);

const ipv4 = /^\d+(\.\d+){3}$/;
const finalDot = /\.$/;

/** The host the check reaches by name, while the domain expiry option is on. */
function optedHost(config: MonitorConfig): string | undefined {
  switch (config.type) {
    case "http":
      return config.domainExpiry === false
        ? undefined
        : new URL(config.url).hostname;
    case "tcp":
      return config.domainExpiry === false ? undefined : config.host;
    case "dns":
      return config.domainExpiry === false ? undefined : config.name;
    default:
      return;
  }
}

/** The host whose registration the monitor reads, in lower case without a final dot: an HTTP monitor's URL host, a TCP monitor's host, a DNS monitor's name; nothing with the option off, for any other check type, or for an IP address or a name of one label, which no registry holds. */
export function registrationHost(config: MonitorConfig): string | undefined {
  const host = optedHost(config);
  return host === undefined ? undefined : registrableHost(host);
}

/** The host in lower case without a final dot, or nothing for an IP address, a name of one label or one under a TLD set aside for special use, which no registry holds. */
export function registrableHost(host: string): string | undefined {
  const name = host.toLowerCase().replace(finalDot, "");
  const labels = name.split(".");
  // An IPv6 address has colons (in brackets in a URL), an IPv4 one is four numbers.
  if (
    name.includes(":") ||
    ipv4.test(name) ||
    labels.length < 2 ||
    specialUse.has(labels.at(-1) ?? "")
  ) {
    return;
  }
  return name;
}

/** The labels a ccTLD's registry gives the zones it runs for others to register under (`com.mx`, `co.uk`, `gov.qa`): the registry holds a record of the zone itself, which is no one's registration. */
const zoneLabels = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gov",
  "mil",
  "ne",
  "net",
  "or",
  "org",
  "sch",
]);

/** The names a registry is asked for the host, longest first: the host, then each parent down to two labels, leaving out a zone a ccTLD's registry runs. A registry answers for the registered one and not for a name under it, so the first it knows is the registration. */
export function registrationCandidates(host: string): string[] {
  const labels = host.split(".");
  return labels
    .slice(0, -1)
    .map((_label, index) => labels.slice(index))
    .filter(
      (name) =>
        !(
          name.length === 2 &&
          name[1]?.length === 2 &&
          zoneLabels.has(name[0] ?? "")
        )
    )
    .map((name) => name.join("."));
}

/** Whether a registration that expires at `expiresAt` is expiring at `now`: within the warning days, or already expired. */
export function registrationExpiring(expiresAt: number, now: number): boolean {
  return expiresAt - now <= domainExpiryWarningDays * 86_400_000;
}

/** Whether the warning is due: the expiry date is known, expiring, and has not had its warning yet. */
export function registrationWarningDue(
  record: Pick<DomainRegistration, "expiresAt" | "warned">,
  now: number
): boolean {
  return (
    record.expiresAt !== undefined &&
    !record.warned &&
    registrationExpiring(record.expiresAt, now)
  );
}
