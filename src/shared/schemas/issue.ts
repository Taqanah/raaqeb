/**
 * What a refusal as `invalid` names: the parts of the input a rule beyond
 * its shape refused, as the management API's `issues` lists them (where in
 * the body, and why). The shape's own refusals come from its schema.
 */

/** One part of an input that was refused. */
export interface Issue {
  readonly message: string;
  /** Where in the body, as keys and indexes. */
  readonly path: readonly (string | number)[];
}

/** An input refused for a rule its shape cannot hold, with the parts it names. */
export interface Invalid {
  readonly issues: readonly Issue[];
  readonly ok: false;
  readonly reason: "invalid";
}

/** The refusal naming these parts. */
export function invalidAt(...issues: readonly Issue[]): Invalid {
  return { issues, ok: false, reason: "invalid" };
}
