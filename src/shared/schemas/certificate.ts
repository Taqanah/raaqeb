/**
 * The certificate record (CONTEXT.md "Certificate record"): what Raaqeb knows about an HTTPS monitor's current certificate. One
 * per monitor with the expiry option on, replaced when the fingerprint
 * changes; no history in v1.
 */
import { z } from "zod";

/** The warnings a certificate gets: once at the monitor's threshold and once more at 1 day; each certificate starts with none. */
export const certificateWarnings = ["threshold", "last_day"] as const;
export type CertificateWarning = (typeof certificateWarnings)[number];

export interface CertificateRecord {
  /** The SHA-256 fingerprint as the platform prints it: upper-case hex pairs joined by colons. */
  readonly fingerprint: string;
  /** The issuer's distinguished name as text, in the certificate's order. */
  readonly issuer: string;
  /** UTC milliseconds of the read that last saw this certificate. */
  readonly lastSeenAt: number;
  readonly monitorId: string;
  /** The subject alternative names, DNS names and IP addresses, without their prefixes. */
  readonly names: readonly string[];
  /** The subject's distinguished name as text, in the certificate's order. */
  readonly subject: string;
  /** UTC milliseconds. */
  readonly validFrom: number;
  /** UTC milliseconds. */
  readonly validTo: number;
  /** The last warning sent for this certificate; absent when none was. A new fingerprint starts over. */
  readonly warned?: CertificateWarning;
}

/** The names column, JSON text parsed at the edge. */
export const certificateNamesSchema = z.array(z.string());

/** The default warning threshold of the TLS expiry option, in days. */
export const tlsExpiryDefaultDays = 14;
