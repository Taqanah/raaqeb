/**
 * The registration reader (CONTEXT.md "Domain registration"): finds the
 * registration a host's domain is under and when it expires. A TLD with an
 * RDAP server in IANA's bootstrap file is asked over RDAP; any other is asked
 * over WHOIS, at the server IANA's WHOIS names for it. The registry is asked
 * one name, the registered domain the Public Suffix List gives, so no name
 * under it leaves the install. A registry that answers with no expiry date, or
 * with one that does not read, gives an unknown date, which never warns. It does no I/O beyond the
 * injected `fetch` and `whois`; the bootstrap file and the WHOIS servers are
 * kept in memory, and each name's answer is kept for the rest of its UTC day,
 * so monitors under one domain ask its registry once a day.
 */
import { z } from "zod";
import type { DomainRegistration } from "@/shared/schemas/registration.ts";
import { readBody } from "./body.ts";
import { publicSuffixRules } from "./public-suffixes.ts";
import { whoisAnswerOf, whoisServerOf } from "./whois.ts";

const dayMs = 86_400_000;

/** The I/O the reader borrows; tests hand in fakes. */
export interface RegistrationIo {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Asks a WHOIS server on port 43 and answers its whole reply as text; rejects on a connection error, the timeout or a reply past the cap. */
  readonly whois: (server: string, query: string) => Promise<string>;
}

/** What a read found: the registered domain and its expiry, each absent when no registry gave one. */
export type RegistrationRead = Pick<DomainRegistration, "domain" | "expiresAt">;

export interface RegistrationReader {
  /** Reads the registration the host is under; nothing when a registry, or IANA, could not be reached or answered in a way that is no answer, so the stored registration stays as it was. */
  read: (host: string) => Promise<RegistrationRead | undefined>;
}

/** IANA's RDAP bootstrap file for domain names (RFC 9224). */
export const rdapBootstrapUrl = "https://data.iana.org/rdap/dns.json";

/** IANA's WHOIS server, which names each TLD's own. */
export const ianaWhoisServer = "whois.iana.org";

/** The bootstrap file and the WHOIS servers are read again this long after; IANA changes them rarely. */
export const directoryLifetimeMs = 7 * 86_400_000;

/** One RDAP request's or WHOIS answer's timeout. */
export const registrationReadTimeoutMs = 10_000;

/** An RDAP answer or IANA's file past this many bytes is no answer; the bootstrap file is some 70 kB. */
const answerBytes = 1_048_576;

/** An expiry further in the past than this cannot be a registration still in use: registries delete a lapsed name within about 75 days. */
const longGoneMs = 90 * dayMs;

/** A registration is read once a UTC day: the first pass of each day reads every one, so monitors under one domain are read together. */
export function registrationReadDue(
  record: Pick<DomainRegistration, "readAt"> | undefined,
  now: number
): boolean {
  return (
    record === undefined ||
    Math.floor(record.readAt / dayMs) < Math.floor(now / dayMs)
  );
}

// A search of the text itself: a Set of the rules would hold some 800 kB of heap for the few lookups a day's reads make.
const listed = (rule: string) => publicSuffixRules.includes(`\n${rule}\n`);

/** A label a registry can hold: 1 to 63 letters, digits or hyphens, no hyphen at either end, and `--` in places 3 and 4 only in an `xn--` name. */
const holdable = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const reservedDashes = /^(?!xn)..--/;

/** The registered domain the host is under, the public suffix and one label more, by the Public Suffix List's algorithm; nothing for a host that is itself a public suffix, whose ending the list does not name, or whose registered label no registry can hold. */
export function registeredDomain(host: string): string | undefined {
  const name = suffixed(host);
  const label = name?.slice(0, name.indexOf("."));
  return label !== undefined &&
    holdable.test(label) &&
    !reservedDashes.test(label)
    ? name
    : undefined;
}

/** The public suffix and one label more, whatever that label holds. */
function suffixed(host: string): string | undefined {
  const labels = host.split(".");
  // Longest first, so the first rule that matches is the one that prevails; an exception rule names the registered domain itself.
  for (let start = 0; start < labels.length; start += 1) {
    const name = labels.slice(start).join(".");
    if (listed(`!${name}`)) {
      return name;
    }
    if (listed(name) || listed(`*.${labels.slice(start + 1).join(".")}`)) {
      return start === 0 ? undefined : labels.slice(start - 1).join(".");
    }
  }
  // No rule matches: an ending the list does not name is no TLD a registry runs, as far as this copy knows, so nothing is asked.
}

/** What a registry said of one name: that it holds no such name, or the registration it holds. */
type Answer =
  | { readonly held: false }
  | ({ readonly held: true } & RegistrationRead);

const notHeld: Answer = { held: false };
const unknown: RegistrationRead = { domain: undefined, expiresAt: undefined };

/** Each TLD's RDAP base URL from IANA's bootstrap file, and the WHOIS servers IANA named so far. */
interface Directory {
  readonly rdap: ReadonlyMap<string, string>;
  readonly readAt: number;
  readonly whois: Map<string, string | undefined>;
}

const bootstrapSchema = z.object({
  services: z.array(
    z.tuple([z.array(z.string()), z.array(z.string())], z.unknown())
  ),
});

const rdapDomainSchema = z.object({
  events: z
    .array(z.object({ eventAction: z.string(), eventDate: z.string() }))
    .optional(),
  ldhName: z.string().optional(),
});

const rdapRequest = (): RequestInit => ({
  headers: { accept: "application/rdap+json" },
  signal: AbortSignal.timeout(registrationReadTimeoutMs),
});

async function jsonOf(response: Response): Promise<unknown> {
  const body = await readBody(response, { read: 0 }, answerBytes);
  return JSON.parse(new TextDecoder().decode(body));
}

export function createRegistrationReader(
  io: RegistrationIo
): RegistrationReader {
  let directory: Directory | undefined;
  /** Each name's answer on the UTC day `answeredOn`. */
  const answers = new Map<string, Answer>();
  let answeredOn: number | undefined;

  async function directoryAt(now: number): Promise<Directory> {
    if (directory && now - directory.readAt < directoryLifetimeMs) {
      return directory;
    }
    const response = await io.fetch(rdapBootstrapUrl, rdapRequest());
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`IANA's bootstrap file answered ${response.status}`);
    }
    const file = bootstrapSchema.parse(await jsonOf(response));
    const rdap = new Map<string, string>();
    for (const [tlds, urls] of file.services) {
      const url = urls.find((each) => each.startsWith("https:")) ?? urls[0];
      if (url === undefined) {
        continue;
      }
      const base = url.endsWith("/") ? url : `${url}/`;
      for (const tld of tlds) {
        rdap.set(tld.toLowerCase(), base);
      }
    }
    directory = { rdap, readAt: now, whois: new Map() };
    return directory;
  }

  async function askRdap(base: string, name: string): Promise<Answer> {
    const response = await io.fetch(`${base}domain/${name}`, rdapRequest());
    // A registry answers a name it does not hold with 404; any other refusal, 400 included, is an error and no answer.
    if (response.status === 404) {
      await response.body?.cancel();
      return notHeld;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`the RDAP server answered ${response.status}`);
    }
    const domain = rdapDomainSchema.parse(await jsonOf(response));
    const expiration = domain.events?.find(
      (each) => each.eventAction === "expiration"
    );
    const expiresAt = Date.parse(expiration?.eventDate ?? "");
    return {
      // A record that names no domain is no registration: .name answers so for a shared second level (smith.name).
      domain: domain.ldhName?.toLowerCase(),
      expiresAt: Number.isNaN(expiresAt) ? undefined : expiresAt,
      held: true,
    };
  }

  async function askWhois(server: string, name: string): Promise<Answer> {
    const said = whoisAnswerOf(await io.whois(server, name));
    // A rate limit, an error or an empty reply says nothing of the name, so nothing above it may be read in its place.
    if (!said) {
      throw new Error("the WHOIS answer is neither a record nor a not-found");
    }
    return said.held
      ? { domain: said.domain ?? name, expiresAt: said.expiresAt, held: true }
      : notHeld;
  }

  /** How the TLD's registry is asked for a name, or nothing when it has neither an RDAP nor a WHOIS server. */
  async function askerOf(
    tld: string,
    now: number
  ): Promise<((name: string) => Promise<Answer>) | undefined> {
    const { rdap, whois } = await directoryAt(now);
    const base = rdap.get(tld);
    if (base !== undefined) {
      return (name) => askRdap(base, name);
    }
    if (!whois.has(tld)) {
      const record = whoisServerOf(await io.whois(ianaWhoisServer, tld));
      // Kept for the week only when IANA answered with its record of the TLD.
      if (!record) {
        throw new Error("IANA's answer is no record of the TLD");
      }
      whois.set(tld, record.server);
    }
    const server = whois.get(tld);
    return server === undefined ? undefined : (name) => askWhois(server, name);
  }

  /** The name's answer, asked once a UTC day. */
  async function answerOf(
    name: string,
    ask: (name: string) => Promise<Answer>,
    now: number
  ): Promise<Answer> {
    const day = Math.floor(now / dayMs);
    if (answeredOn !== day) {
      answers.clear();
      answeredOn = day;
    }
    const kept = answers.get(name);
    if (kept) {
      return kept;
    }
    const answer = await ask(name);
    answers.set(name, answer);
    return answer;
  }

  return {
    read: async (host) => {
      const name = registeredDomain(host);
      if (name === undefined) {
        return unknown;
      }
      const now = io.now();
      try {
        const ask = await askerOf(host.slice(host.lastIndexOf(".") + 1), now);
        if (!ask) {
          return unknown;
        }
        const answer = await answerOf(name, ask, now);
        // A record of another name is no registration of this one, and only the name asked is ever stored.
        if (!answer.held || answer.domain !== name) {
          return unknown;
        }
        const { expiresAt } = answer;
        return {
          domain: name,
          expiresAt:
            expiresAt !== undefined && expiresAt < now - longGoneMs
              ? undefined
              : expiresAt,
        };
      } catch {
        // A registry or IANA that could not be reached, or answered nonsense, is no answer; the next read asks again.
      }
    },
  };
}
