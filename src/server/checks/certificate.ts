/**
 * The certificate reader (CONTEXT.md "Certificate record"): reads the leaf certificate of an HTTPS monitor with the expiry
 * option on over its own TLS connection, every 12 hours and when the monitor
 * has no record yet (a new monitor, or one whose address changed and whose
 * record the monitors module removed). It does no I/O beyond the injected
 * `readTls`; the scheduler's certificate pass (`scheduler/certificates.ts`)
 * reads the records, calls it for each due monitor and stores what it
 * read. A handshake failure on a check is that check's reason, never this
 * reader's business.
 */
import type { CertificateRecord } from "@/shared/schemas/certificate.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";

/** A connection target for the TLS read; `serverName` is the SNI, absent for an IP literal. */
export interface TlsTarget {
  readonly host: string;
  readonly port: number;
  readonly serverName: string | undefined;
  readonly timeoutMs: number;
}

/** A distinguished name as the platform hands it over: attribute to value, or values when repeated. */
export type DistinguishedName = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** The leaf certificate as the platform hands it over after the handshake; the fields this reader keeps. */
export interface PeerCertificate {
  /** Upper-case hex pairs joined by colons. */
  readonly fingerprint256: string;
  readonly issuer: DistinguishedName;
  readonly subject: DistinguishedName;
  /** `DNS:a.example, IP Address:192.0.2.1`; absent when the certificate has none. */
  readonly subjectaltname?: string | undefined;
  /** OpenSSL's text, `Jul 29 22:10:08 2026 GMT`. */
  readonly valid_from: string;
  readonly valid_to: string;
}

/** Connects with TLS, completes the handshake without verifying, and answers the peer's leaf certificate; rejects with the runtime error. */
export type ReadTls = (target: TlsTarget) => Promise<PeerCertificate>;

/** The I/O the reader borrows; tests hand in fakes. */
export interface TlsIo {
  readonly now: () => number;
  readonly readTls: ReadTls;
}

/** A record is read again this long after it was last seen (every 12 hours). */
export const certificateReadIntervalMs = 12 * 60 * 60 * 1000;

/** The reader's own timeout for one connection and handshake. */
export const certificateReadTimeoutMs = 10_000;

/** Where the monitor's certificate is read, or nothing: the monitor is not HTTPS or its expiry option is off. */
export function certificateTarget(
  monitor: Pick<Monitor, "config">
): TlsTarget | undefined {
  const { config } = monitor;
  if (config.type !== "http" || config.tlsExpiryDays === undefined) {
    return;
  }
  const url = new URL(config.url);
  if (url.protocol !== "https:") {
    return;
  }
  // The URL keeps an IPv6 literal in brackets; the socket wants it bare.
  const host = url.hostname.replace(bracketed, "$1");
  return {
    host,
    port: url.port ? Number(url.port) : 443,
    serverName: isIpLiteral(host) ? undefined : host,
    timeoutMs: certificateReadTimeoutMs,
  };
}

const bracketed = /^\[(.*)\]$/;
const ipv4 = /^\d+(\.\d+){3}$/;

function isIpLiteral(host: string): boolean {
  return host.includes(":") || ipv4.test(host);
}

/** Whether the reader is due: no record, or the record was last seen the read interval ago or longer. */
export function certificateReadDue(
  record: Pick<CertificateRecord, "lastSeenAt"> | undefined,
  now: number
): boolean {
  return (
    record === undefined || record.lastSeenAt + certificateReadIntervalMs <= now
  );
}

/** The record a leaf certificate makes: names split and stripped of their prefixes, dates as milliseconds, distinguished names as text. */
export function certificateRecordOf(
  monitorId: string,
  peer: PeerCertificate,
  now: number
): CertificateRecord {
  return {
    fingerprint: peer.fingerprint256,
    issuer: textOfName(peer.issuer),
    lastSeenAt: now,
    monitorId,
    names: namesOf(peer.subjectaltname),
    subject: textOfName(peer.subject),
    validFrom: Date.parse(peer.valid_from),
    validTo: Date.parse(peer.valid_to),
  };
}

/** `C=US, O=Example, CN=status.raaqeb.dev`, in the certificate's own order; a repeated attribute repeats its key. */
function textOfName(name: DistinguishedName): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(name)) {
    if (typeof value === "string") {
      parts.push(`${key}=${value}`);
    } else if (value) {
      parts.push(...value.map((one) => `${key}=${one}`));
    }
  }
  return parts.join(", ");
}

/** Each alternative name without its `DNS:` or `IP Address:` prefix; an IPv6 address keeps its own colons. */
function namesOf(subjectaltname: string | undefined): string[] {
  if (!subjectaltname) {
    return [];
  }
  return subjectaltname.split(", ").map((entry) => {
    const colon = entry.indexOf(":");
    return colon === -1 ? entry : entry.slice(colon + 1);
  });
}

/** Reads the monitor's certificate now, or answers nothing when the monitor has no target or the read failed. */
export async function readCertificate(
  monitor: Pick<Monitor, "id" | "config">,
  io: TlsIo
): Promise<CertificateRecord | undefined> {
  const target = certificateTarget(monitor);
  if (!target) {
    return;
  }
  try {
    const peer = await io.readTls(target);
    const record = certificateRecordOf(monitor.id, peer, io.now());
    // A date the platform printed in a form Date.parse does not read would store NaN; no record beats a wrong one.
    return Number.isNaN(record.validFrom) || Number.isNaN(record.validTo)
      ? undefined
      : record;
  } catch {
    // A failed read is not a check and has no reason to record; the record stays as it was.
  }
}
