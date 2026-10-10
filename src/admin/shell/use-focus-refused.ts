/**
 * A refused form hands the focus to its first marked field, so the operator
 * lands on what to fix. `refusal` changes with every refused submit; the
 * fields are read after render, never in render scope (ADR-0006).
 */
import { type RefObject, useEffect } from "react";

export function useFocusRefused(
  form: RefObject<HTMLFormElement | null>,
  refusal: unknown
): void {
  useEffect(() => {
    if (refusal) {
      form.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
    }
  }, [form, refusal]);
}
