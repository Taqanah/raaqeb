/**
 * An HTTP monitor's client certificate (CONTEXT.md "Client certificate"),
 * read before it is saved and before each request: that the PEM is a
 * certificate, that the key opens (with its passphrase when it is encrypted)
 * and belongs to it, the dates it is valid between, and that a CA bundle is
 * made of certificates. Pure: `now` is a parameter, and the reading is the
 * platform's own X.509 and key parsing, which Bun has no other way to reach.
 */
// biome-ignore lint/style/noRestrictedImports: Bun has no X.509 or private key parser; node:crypto's is the one Bun ships
import { createPrivateKey, X509Certificate } from "node:crypto";

/** What is wrong with a client certificate and its key. */
export type ClientTlsProblem =
  /** The certificate is not a PEM certificate. */
  | "certificate"
  /** There is no key, or it is not a PEM key, or the passphrase does not open it. */
  | "key"
  /** The key opens and is not the certificate's. */
  | "mismatch";

export type ClientCertificateReading =
  | { readonly ok: true; readonly notAfter: number; readonly notBefore: number }
  | { readonly ok: false; readonly problem: ClientTlsProblem };

/** The certificate's validity dates, as UTC milliseconds. */
export interface CertificateDates {
  readonly notAfter: number;
  readonly notBefore: number;
}

function parse(certificate: string): X509Certificate | undefined {
  try {
    return new X509Certificate(certificate);
  } catch {
    // Not a certificate: the caller names which problem it is.
  }
}

function datesOf(parsed: X509Certificate): CertificateDates {
  return {
    notAfter: Date.parse(parsed.validTo),
    notBefore: Date.parse(parsed.validFrom),
  };
}

/** Reads the client certificate with its key and passphrase, deepest problem first: the certificate, then the key, then whether they belong together. */
export function readClientCertificate(
  certificate: string,
  key: string | undefined,
  passphrase: string | undefined
): ClientCertificateReading {
  const parsed = parse(certificate);
  if (!parsed) {
    return { ok: false, problem: "certificate" };
  }
  if (key === undefined) {
    return { ok: false, problem: "key" };
  }
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({ key, passphrase });
  } catch {
    return { ok: false, problem: "key" };
  }
  if (!parsed.checkPrivateKey(privateKey)) {
    return { ok: false, problem: "mismatch" };
  }
  return { ok: true, ...datesOf(parsed) };
}

/** The dates the first certificate of the PEM is valid between, or nothing when it is not a certificate. */
export function certificateDates(
  certificate: string
): CertificateDates | undefined {
  const parsed = parse(certificate);
  return parsed && datesOf(parsed);
}

/** Whether `now` is outside the dates: `expired` after them, `not_yet_valid` before. */
export function datesProblem(
  dates: CertificateDates,
  now: number
): "expired" | "not_yet_valid" | undefined {
  if (now > dates.notAfter) {
    return "expired";
  }
  if (now < dates.notBefore) {
    return "not_yet_valid";
  }
}

const certificateBlock =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const armour = /-----BEGIN [A-Z ]+-----/g;

/** Whether the PEM holds at least one certificate and every block in it is one. */
export function caCertificatesReadable(bundle: string): boolean {
  const blocks = bundle.match(certificateBlock) ?? [];
  // A block that is not a certificate (a key pasted by mistake) is as wrong as one that does not parse.
  return (
    blocks.length > 0 &&
    (bundle.match(armour) ?? []).length === blocks.length &&
    blocks.every((block) => parse(block) !== undefined)
  );
}
