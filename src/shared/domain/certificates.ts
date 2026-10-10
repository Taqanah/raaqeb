/**
 * The certificate record's pure rules: whether a
 * certificate is within a warning threshold, which warning is due, and the
 * whole days it has left. No I/O; `now` is a parameter.
 */
import type {
  CertificateRecord,
  CertificateWarning,
} from "@/shared/schemas/certificate.ts";

/** Whether the certificate expires within `days` of `now`, or already has. */
export function certificateExpiresWithin(
  record: Pick<CertificateRecord, "validTo">,
  days: number,
  now: number
): boolean {
  return record.validTo - now <= days * 86_400_000;
}

/** The warning to send at `now`, or nothing: the last day's once the certificate expires within a day or has expired, the threshold's once within the monitor's days, each only when the certificate has not had it yet, and no threshold warning after the last day's. */
export function certificateWarningDue(
  record: Pick<CertificateRecord, "validTo" | "warned">,
  thresholdDays: number,
  now: number
): CertificateWarning | undefined {
  if (record.warned === "last_day") {
    return;
  }
  if (certificateExpiresWithin(record, 1, now)) {
    return "last_day";
  }
  if (
    record.warned === undefined &&
    certificateExpiresWithin(record, thresholdDays, now)
  ) {
    return "threshold";
  }
}

/** Whole days left before expiry, rounded down; negative once expired. */
export function daysLeft(validTo: number, now: number): number {
  return Math.floor((validTo - now) / 86_400_000);
}
