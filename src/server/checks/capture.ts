/**
 * Captures (CONTEXT.md "Capture", "Capture mode"): the response
 * headers and the first 4 KB of the body, kept only when the monitor's
 * capture mode says so. Set-Cookie and any header whose name contains
 * "auth", "token", "key" or "cookie" keep their name and lose their value.
 * Request headers and credentials never enter a capture, not even when the
 * response repeats one: every credential the check sent is masked in the
 * headers and the body before the cut.
 */
import {
  type Capture,
  type CaptureHeader,
  type CheckResult,
  captureBodyBytes,
} from "@/shared/schemas/check.ts";
import type { CaptureMode } from "@/shared/schemas/monitor.ts";

/** What a capture, a failure detail and an error text keep in place of a credential the check sent. */
export const credentialMask = "[REDACTED]";

/** The byte forms of the credentials a check sent that the response may repeat. */
export type CredentialPatterns = readonly Uint8Array[];

/** The patterns for the credential values a check sent: each value as sent and as written inside a JSON string, with its slashes escaped or not. An empty value gives nothing away. */
export function credentialPatterns(
  values: readonly string[]
): CredentialPatterns {
  return values
    .filter((value) => value !== "")
    .flatMap((value) => {
      const inJson = JSON.stringify(value).slice(1, -1);
      // PHP's json_encode escapes every slash by default, and base64 holds slashes.
      return [...new Set([value, inJson, inJson.replaceAll("/", "\\/")])];
    })
    .map((form) => encoder.encode(form));
}

/** The bytes with every occurrence of a pattern replaced by the mask; occurrences that overlap or touch become one mask. */
export function maskCredentials(
  bytes: Uint8Array,
  patterns: CredentialPatterns
): Uint8Array {
  // Buffer's indexOf is the platform's subsequence search; a Uint8Array has none.
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const found: [start: number, end: number][] = [];
  for (const pattern of patterns) {
    for (
      let at = haystack.indexOf(pattern);
      at !== -1;
      at = haystack.indexOf(pattern, at + 1)
    ) {
      found.push([at, at + pattern.length]);
    }
  }
  if (found.length === 0) {
    return bytes;
  }
  const pieces: Uint8Array[] = [];
  let kept = 0;
  for (const [start, end] of found.toSorted(([a], [b]) => a - b)) {
    if (start > kept || pieces.length === 0) {
      pieces.push(bytes.subarray(kept, start), maskBytes);
    }
    kept = Math.max(kept, end);
  }
  pieces.push(bytes.subarray(kept));
  return Bun.concatArrayBuffers(pieces, Number.POSITIVE_INFINITY, true);
}

/** The text with every occurrence of a pattern replaced by the mask. */
export function maskCredentialText(
  text: string,
  patterns: CredentialPatterns
): string {
  return patterns.length === 0
    ? text
    : decoder.decode(maskCredentials(encoder.encode(text), patterns));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maskBytes = encoder.encode(credentialMask);

const redactedNameParts = ["auth", "token", "key", "cookie"];

/** Whether a header's value is dropped from a capture. */
export function isRedactedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return redactedNameParts.some((part) => lower.includes(part));
}

/** The headers as a capture keeps them: lower-cased, listed by name (the platform lists Set-Cookie apart), redacted by name, the credentials sent masked in every value kept. */
export function redactHeaders(
  headers: Headers,
  patterns: CredentialPatterns = []
): CaptureHeader[] {
  return Array.from(headers, ([name, value]) => ({
    name,
    value: isRedactedHeader(name)
      ? undefined
      : maskCredentialText(value, patterns),
  })).toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Whether a check with this result keeps a capture under this mode: never off, down only on failure, every check always. */
export function keepsCapture(mode: CaptureMode, result: CheckResult): boolean {
  switch (mode) {
    case "off":
      return false;
    case "on_failure":
      return result === "down";
    case "always":
      return true;
    default:
      return mode satisfies never;
  }
}

/** The capture of a response: redacted headers and the body cut to the cap, the credentials sent masked in both before the cut. */
export function captureOf(
  key: Pick<Capture, "monitorId" | "startedAt">,
  headers: Headers,
  body: Uint8Array,
  patterns: CredentialPatterns = []
): Capture {
  return {
    body: maskCredentials(body, patterns).slice(0, captureBodyBytes),
    headers: redactHeaders(headers, patterns),
    monitorId: key.monitorId,
    startedAt: key.startedAt,
  };
}
