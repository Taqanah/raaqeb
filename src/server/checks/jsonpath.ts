/**
 * The JSON path of the JSON assertions read against a parsed
 * document. The grammar lives in shared/domain/jsonpath.ts, so the form
 * refuses the same paths the check cannot read.
 */
import { parseJsonPath } from "@/shared/domain/jsonpath.ts";

export type JsonPathRead =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false };

/** The value the path names in the document, or not found when a step is missing. */
export function readJsonPath(document: unknown, path: string): JsonPathRead {
  const steps = parseJsonPath(path);
  if (!steps) {
    return { found: false };
  }
  let value = document;
  for (const step of steps) {
    if (typeof step === "number") {
      if (!(Array.isArray(value) && step < value.length)) {
        return { found: false };
      }
      value = value[step];
      continue;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.hasOwn(value, step)
    ) {
      return { found: false };
    }
    value = (value as Record<string, unknown>)[step];
  }
  return { found: true, value };
}

/** A JSON value as the text an assertion compares: a string as is, anything else as JSON. */
export function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
