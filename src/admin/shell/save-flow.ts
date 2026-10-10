/**
 * One save flow for every admin form. A form compares the draft it
 * holds with its baseline, what it started from or last saved: Save can be
 * pressed only while they differ and no save is running, and a field changed
 * back to its saved value reads unchanged again. The footer's line follows the
 * last outcome until the next change makes it old news: unsaved changes, a
 * save in progress, saved, or a refusal worded through the catalog.
 */
import { useCallback, useMemo, useState } from "react";

export type SaveState<Refusal extends string> =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly reason: Refusal };

/** What the footer's line says. */
export type SaveLine<Refusal extends string> =
  | { readonly kind: "none" }
  | { readonly kind: "unsaved" }
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly reason: Refusal };

/** A form's save as it stands: its baseline, the last outcome, and the draft that outcome was about. */
export interface SaveFlow<Draft, Refusal extends string> {
  readonly about: Draft;
  readonly baseline: Draft;
  readonly outcome: SaveState<Refusal>;
}

/** What happened to a form's save; each carries the draft it is about. */
export type SaveEvent<Draft, Refusal extends string> =
  /** A save started with this draft. */
  | { readonly kind: "pending"; readonly draft: Draft }
  /** The server stored it; the form holds this draft now, which may differ from the one sent (a secret field emptied, a posted text cleared). */
  | { readonly kind: "saved"; readonly draft: Draft }
  | { readonly kind: "failed"; readonly draft: Draft; readonly reason: Refusal }
  /** The stored record moved under the form (the scheduler, a newer update): `baseline` is what it holds now, `draft` what the form holds after taking it in. */
  | {
      readonly kind: "rebased";
      readonly baseline: Draft;
      readonly draft: Draft;
    };

/** What the footer shows for the draft the form holds now. */
export interface SaveView<Refusal extends string> {
  /** Save can be pressed: the draft differs from the baseline and no save runs. */
  readonly canSave: boolean;
  readonly changed: boolean;
  readonly line: SaveLine<Refusal>;
  readonly pending: boolean;
}

/** Whether two drafts hold the same values: plain data compared by value, key order aside. */
export function sameDraft(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  const left = Object.entries(a);
  const right = new Map(Object.entries(b));
  return (
    left.length === right.size &&
    left.every(
      ([key, value]) => right.has(key) && sameDraft(value, right.get(key))
    )
  );
}

const idle: { readonly kind: "idle" } = { kind: "idle" };

/** A form's save before any outcome. */
export function flowOf<Draft, Refusal extends string>(
  baseline: Draft
): SaveFlow<Draft, Refusal> {
  return { about: baseline, baseline, outcome: idle };
}

export function nextFlow<Draft, Refusal extends string>(
  flow: SaveFlow<Draft, Refusal>,
  event: SaveEvent<Draft, Refusal>
): SaveFlow<Draft, Refusal> {
  switch (event.kind) {
    case "pending":
      return { ...flow, about: event.draft, outcome: { kind: "pending" } };
    case "saved":
      return {
        about: event.draft,
        baseline: event.draft,
        outcome: { kind: "saved" },
      };
    case "failed":
      return {
        ...flow,
        about: event.draft,
        outcome: { kind: "failed", reason: event.reason },
      };
    default:
      // The outcome follows the form to the values it took in, so a refusal saying the record moved stays readable.
      return { ...flow, about: event.draft, baseline: event.baseline };
  }
}

export function viewOf<Draft, Refusal extends string>(
  flow: SaveFlow<Draft, Refusal>,
  draft: Draft
): SaveView<Refusal> {
  const changed = !sameDraft(flow.baseline, draft);
  const pending = flow.outcome.kind === "pending";
  // An outcome speaks of the draft it was reached with; a later change makes it old news.
  const current = pending || sameDraft(flow.about, draft) ? flow.outcome : idle;
  return {
    canSave: changed && !pending,
    changed,
    line:
      current.kind === "idle" && changed
        ? { kind: "unsaved" }
        : lineOf(current),
    pending,
  };
}

/** The line a command's outcome shows, for a form with no draft to compare (Appearance, the second step). */
export function lineOf<Refusal extends string>(
  state: SaveState<Refusal>
): SaveLine<Refusal> {
  return state.kind === "saved" || state.kind === "failed"
    ? state
    : { kind: "none" };
}

/** The save flow of a form holding `draft`; `start` is the baseline, the first draft unless a new record starts from a copy, which is worth saving at once. */
export function useSaveFlow<Draft, Refusal extends string>(
  draft: Draft,
  start: Draft = draft
): SaveView<Refusal> & {
  readonly report: (event: SaveEvent<Draft, Refusal>) => void;
} {
  const [flow, setFlow] = useState(() => flowOf<Draft, Refusal>(start));
  const report = useCallback((event: SaveEvent<Draft, Refusal>) => {
    setFlow((current) => nextFlow(current, event));
  }, []);
  const view = useMemo(() => viewOf(flow, draft), [draft, flow]);
  return { ...view, report };
}
