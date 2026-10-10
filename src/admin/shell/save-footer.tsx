/**
 * A form's save, on every create, edit and settings form: the line on
 * the start side follows the last outcome (unsaved changes, saved, a refusal
 * worded through the catalog) in one live region that stays in the page;
 * Save on the end side rests while there is nothing to save or a save runs.
 * Resting, it stays focusable and dimmed, with the reason for a screen reader
 * only: the dimmed button explains itself, so no visible line sits under it.
 */
import { type ReactNode, useId } from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Button } from "@/shared/ui/button.tsx";
import { CheckIcon, LoaderIcon } from "@/shared/ui/icons.tsx";
import { FormFooter } from "./page.tsx";
import type { SaveLine as Line, SaveView } from "./save-flow.ts";

export interface SaveLineProps<Refusal extends string> {
  readonly line: Line<Refusal>;
  readonly refusals: Readonly<Record<Refusal, MessageId>>;
  /** The words of a save that went through. */
  readonly saved?: MessageId;
}

/** The outcome line; present while empty, so what it says next is announced. */
export function SaveLine<Refusal extends string>({
  line,
  refusals,
  saved = "app_saved",
}: SaveLineProps<Refusal>): ReactNode {
  const { t } = useMessages();
  return (
    <output
      aria-live="polite"
      className="flex min-w-0 items-center gap-1.5 text-sm"
      data-reason={line.kind === "failed" ? line.reason : undefined}
      data-slot="save-outcome"
      data-state={line.kind}
    >
      {line.kind === "unsaved" ? (
        <>
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-status-degraded"
          />
          <span className="text-muted-foreground">{t("app_unsaved")}</span>
        </>
      ) : null}
      {line.kind === "saved" ? (
        <>
          <CheckIcon className="size-4 shrink-0 text-action" />
          <span className="text-muted-foreground">{t(saved)}</span>
        </>
      ) : null}
      {line.kind === "failed" ? (
        <span className="text-destructive-text">
          {t(refusals[line.reason])}
        </span>
      ) : null}
    </output>
  );
}

export interface SaveButtonProps<Refusal extends string> {
  /** The form cannot save for a reason said above it (an incident with no component to affect). */
  readonly disabled?: boolean;
  /** A new record: with nothing typed there is nothing to save yet, rather than no changes. */
  readonly fresh?: boolean;
  readonly label?: string;
  readonly pendingLabel?: string;
  /** The button's `data-slot`, which the browser tests press. */
  readonly slot?: string;
  readonly view: SaveView<Refusal>;
}

/** Save itself, which Ctrl or Cmd+S presses through `data-save`; a resting press does nothing, Enter in a field included. */
export function SaveButton<Refusal extends string>({
  disabled = false,
  fresh = false,
  label,
  pendingLabel,
  slot,
  view,
}: SaveButtonProps<Refusal>): ReactNode {
  const { t } = useMessages();
  const id = useId();
  const unchanged = !(view.changed || view.pending || disabled);
  let words: ReactNode = label ?? t("app_save");
  if (view.pending) {
    words = (
      <>
        <LoaderIcon className="motion-safe:animate-spin" />
        {pendingLabel ?? t("app_saving")}
      </>
    );
  }
  return (
    <>
      <Button
        aria-describedby={unchanged ? id : undefined}
        data-save=""
        data-slot={slot}
        disabled={disabled || !view.canSave}
        focusableWhenDisabled
        type="submit"
      >
        {words}
      </Button>
      {unchanged ? (
        <span className="sr-only" id={id}>
          {t(fresh ? "app_nothing_to_save" : "app_no_changes")}
        </span>
      ) : null}
    </>
  );
}

export type SaveFooterProps<Refusal extends string> = SaveButtonProps<Refusal> &
  Omit<SaveLineProps<Refusal>, "line"> & {
    /** Cancel, or anything else before Save. */
    readonly children?: ReactNode;
  };

/** A form's last card's footer with its save: the line, then the form's other buttons and Save. */
export function SaveFooter<Refusal extends string>({
  children,
  refusals,
  saved,
  ...button
}: SaveFooterProps<Refusal>): ReactNode {
  return (
    <FormFooter
      outcome={
        <SaveLine line={button.view.line} refusals={refusals} saved={saved} />
      }
    >
      {children}
      <SaveButton {...button} />
    </FormFooter>
  );
}
