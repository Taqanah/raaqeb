/**
 * A form's field refusals. None show before a save is refused; then the
 * refusals stay with the draft they judged, and once the draft changes the
 * form's own rules judge it again, so a fixed field's line goes as soon as it
 * is fixed and a field broken since shows at once. Every refusal hands the
 * focus to the first marked field.
 */
import { type RefObject, useCallback, useState } from "react";
import { useFocusRefused } from "./use-focus-refused.ts";

/** The last refused save: the draft it sent and the refusals it got, the form's or the server's. */
export interface Refused<Draft, Errors> {
  readonly draft: Draft;
  readonly errors: Errors;
}

/** The refusals to show for the draft the form holds now. */
export function refusalsNow<Draft, Errors extends object>(
  refused: Refused<Draft, Errors> | undefined,
  draft: Draft,
  judge: (draft: Draft) => Errors
): Partial<Errors> {
  if (refused === undefined) {
    return {};
  }
  return refused.draft === draft ? refused.errors : judge(draft);
}

export function useRefusedFields<Draft, Errors extends object>(
  form: RefObject<HTMLFormElement | null>,
  draft: Draft,
  judge: (draft: Draft) => Errors
): {
  readonly errors: Partial<Errors>;
  /** After a refused save: these refusals, about the draft the form holds. */
  readonly refuse: (errors: Errors) => void;
  /** After a save that passed the rules: nothing to show. */
  readonly clear: () => void;
} {
  const [refused, setRefused] = useState<Refused<Draft, Errors>>();
  useFocusRefused(form, refused);
  const refuse = useCallback(
    (errors: Errors) => setRefused({ draft, errors }),
    [draft]
  );
  const clear = useCallback(() => setRefused(undefined), []);
  return { clear, errors: refusalsNow(refused, draft, judge), refuse };
}
