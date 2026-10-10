/**
 * The success rules' evaluator (CONTEXT.md "Success rules", "Assertion"):
 * the assertions run in order and the first failure ends the
 * check. A failing status assertion is the reason "unexpected status", a
 * failing response-time assertion is "slow", every other kind is
 * "assertion failed" with what it expected and saw.
 */
import type { Assertion } from "@/shared/schemas/monitor.ts";
import {
  observedMaxLength,
  type ReasonName,
  type ReasonParams,
} from "@/shared/schemas/reason.ts";
import { type CredentialPatterns, maskCredentialText } from "./capture.ts";
import { jsonText, readJsonPath } from "./jsonpath.ts";

/** What an attempt observed, as the assertions read it. */
export interface ObservedResponse {
  /** The body read up to the cap. */
  readonly body: Uint8Array;
  readonly headers: Headers;
  readonly responseMs: number;
  readonly statusCode: number;
}

export type AssertionVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly assertion: Assertion;
      readonly params: ReasonParams;
      readonly reason: ReasonName;
    };

const statusClass = /^([1-5])xx$/;
const statusRange = /^(\d{3})-(\d{3})$/;

/** Whether a status code is in a status set: `2xx`, `204` or `200-299` entries (shared/schemas/monitor.ts). */
export function statusInSet(
  codes: readonly string[],
  statusCode: number
): boolean {
  return codes.some((entry) => {
    const asClass = statusClass.exec(entry);
    if (asClass) {
      return Math.floor(statusCode / 100) === Number(asClass[1]);
    }
    const asRange = statusRange.exec(entry);
    if (asRange) {
      return (
        statusCode >= Number(asRange[1]) && statusCode <= Number(asRange[2])
      );
    }
    return Number(entry) === statusCode;
  });
}

/** Runs the assertions in order; the first failure is the verdict, the credentials sent masked in the text it quotes before the cut. */
export function evaluateAssertions(
  assertions: readonly Assertion[],
  response: ObservedResponse,
  credentials: CredentialPatterns = []
): AssertionVerdict {
  const body = new LazyBody(response.body);
  for (const assertion of assertions) {
    const verdict = evaluate(assertion, response, body, credentials);
    if (verdict) {
      return verdict;
    }
  }
  return { ok: true };
}

/** A failing verdict for one assertion, or nothing when it passes. */
function evaluate(
  assertion: Assertion,
  response: ObservedResponse,
  body: LazyBody,
  credentials: CredentialPatterns
): AssertionVerdict | undefined {
  switch (assertion.kind) {
    case "status":
      return statusInSet(assertion.codes, response.statusCode)
        ? undefined
        : {
            assertion,
            ok: false,
            params: {
              expected: [...assertion.codes],
              observed: response.statusCode,
              reason: "unexpected_status",
            },
            reason: "unexpected_status",
          };
    case "body_contains":
      return body.text.includes(assertion.text)
        ? undefined
        : failed(assertion, assertion.text, body.text, credentials);
    case "body_not_contains":
      return body.text.includes(assertion.text)
        ? failed(assertion, assertion.text, body.text, credentials)
        : undefined;
    case "json_equals": {
      const read = body.at(assertion.path);
      return read.found && read.text === assertion.value
        ? undefined
        : failed(assertion, assertion.value, read.text, credentials);
    }
    case "json_matches": {
      const read = body.at(assertion.path);
      return read.found && matches(assertion.pattern, read.text)
        ? undefined
        : failed(assertion, assertion.pattern, read.text, credentials);
    }
    case "header_equals": {
      // An absent header equals nothing, not even an empty expected value.
      const observed = response.headers.get(assertion.name);
      return observed === assertion.value
        ? undefined
        : failed(assertion, assertion.value, observed ?? "", credentials);
    }
    case "response_time_under":
      return response.responseMs < assertion.ms
        ? undefined
        : {
            assertion,
            ok: false,
            params: {
              limitMs: assertion.ms,
              observedMs: response.responseMs,
              reason: "slow",
            },
            reason: "slow",
          };
    default:
      return assertion satisfies never;
  }
}

function failed(
  assertion: Assertion,
  expected: string,
  observed: string,
  credentials: CredentialPatterns
): AssertionVerdict {
  return {
    assertion,
    ok: false,
    params: {
      expected: quote(expected, credentials),
      observed: quote(observed, credentials),
      reason: "assertion_failed",
    },
    reason: "assertion_failed",
  };
}

/** A text as a failure detail quotes it: the credentials sent masked, then cut, so one straddling the cut leaves no prefix. */
function quote(text: string, credentials: CredentialPatterns): string {
  return maskCredentialText(text, credentials).slice(0, observedMaxLength);
}

/** An operator's pattern that does not compile fails the assertion rather than the check run. */
function matches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

/** The body decoded once, and parsed as JSON once, only when an assertion asks. */
class LazyBody {
  readonly #bytes: Uint8Array;
  #text: string | undefined;
  #json: { document: unknown } | undefined;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /** The body as text; bytes that are not UTF-8 decode to replacement characters. */
  get text(): string {
    this.#text ??= new TextDecoder().decode(this.#bytes);
    return this.#text;
  }

  /**
   * The text at a JSON path. Not found, with the body itself as the text
   * when the body is not JSON and an empty text when the path is missing,
   * so an assertion never passes on what it could not read.
   */
  at(path: string): { readonly found: boolean; readonly text: string } {
    if (!this.#json) {
      try {
        this.#json = { document: JSON.parse(this.text) };
      } catch {
        return { found: false, text: this.text };
      }
    }
    const read = readJsonPath(this.#json.document, path);
    return read.found
      ? { found: true, text: jsonText(read.value) }
      : { found: false, text: "" };
  }
}
