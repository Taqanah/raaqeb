/**
 * A settings form's save: pending while the server function runs, then
 * saved or a refusal the form words through the catalog. A rejected call
 * (the server unreachable) reads as unavailable, so the form never throws
 * into the router. `useDraftSave` runs it through the shared flow, so
 * Save rests until the form's values differ from what it loaded or last
 * saved; `useSave` is for a command, which has no values to compare
 * (Appearance's click, the second step's switch).
 */
import { useCallback, useState } from "react";
import {
  type SaveState,
  type SaveView,
  useSaveFlow,
} from "@/admin/shell/save-flow.ts";

export type SaveCall<Input, Refusal extends string> = (
  input: Input
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: Refusal }
>;

export function useSave<Input, Refusal extends string>(
  save: SaveCall<Input, Refusal>,
  onSaved?: (input: Input) => void
): {
  readonly state: SaveState<Refusal | "unavailable">;
  readonly fail: (reason: Refusal) => void;
  readonly submit: (input: Input) => void;
} {
  const [state, setState] = useState<SaveState<Refusal | "unavailable">>({
    kind: "idle",
  });
  const fail = useCallback((reason: Refusal) => {
    setState({ kind: "failed", reason });
  }, []);
  const submit = useCallback(
    (input: Input) => {
      setState({ kind: "pending" });
      save(input).then(
        (result) => {
          if (result.ok) {
            setState({ kind: "saved" });
            onSaved?.(input);
          } else {
            setState({ kind: "failed", reason: result.reason });
          }
        },
        () => setState({ kind: "failed", reason: "unavailable" })
      );
    },
    [onSaved, save]
  );
  return { fail, state, submit };
}

/** A settings form's save of the values in `draft`; `start` is the baseline when the shown values are not the stored ones (no channel chosen yet), and `emptied` the draft a form holds once it saved, when the save empties its fields (a password). */
export function useDraftSave<Input, Refusal extends string, Draft>(
  save: SaveCall<Input, Refusal>,
  draft: Draft,
  {
    emptied,
    onSaved,
    start = draft,
  }: {
    readonly emptied?: Draft;
    readonly onSaved?: (input: Input) => void;
    readonly start?: Draft;
  } = {}
): SaveView<Refusal | "unavailable"> & {
  readonly fail: (reason: Refusal) => void;
  readonly submit: (input: Input) => void;
} {
  const flow = useSaveFlow<Draft, Refusal | "unavailable">(draft, start);
  const { report } = flow;
  const fail = useCallback(
    (reason: Refusal) => report({ draft, kind: "failed", reason }),
    [draft, report]
  );
  const submit = useCallback(
    (input: Input) => {
      if (!report({ draft, kind: "pending" })) {
        return;
      }
      save(input).then(
        (result) => {
          if (result.ok) {
            report({ draft: emptied ?? draft, kind: "saved" });
            onSaved?.(input);
          } else {
            report({ draft, kind: "failed", reason: result.reason });
          }
        },
        () => report({ draft, kind: "failed", reason: "unavailable" })
      );
    },
    [draft, emptied, onSaved, report, save]
  );
  return { ...flow, fail, submit };
}
