/**
 * The managed-by-environment pattern: a field a boot setting
 * covers renders its value disabled with the note that an environment
 * variable set it. The same frame shows a read-only value without the note.
 */
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Field, FieldDescription, FieldLabel } from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";

export interface LockedFieldProps {
  readonly hint?: string;
  readonly id: string;
  readonly label: string;
  /** Set by an environment variable: the note says so. */
  readonly managedByEnvironment: boolean;
  readonly value: string;
}

export function LockedField({
  hint,
  id,
  label,
  managedByEnvironment,
  value,
}: LockedFieldProps): ReactNode {
  const { t } = useMessages();
  const note = managedByEnvironment
    ? `${t("app_managed_by_environment")}. ${t("app_managed_by_environment_hint")}`
    : hint;
  return (
    <Field data-managed={managedByEnvironment ? "environment" : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input disabled id={id} readOnly value={value} />
      {note ? (
        <FieldDescription
          data-slot={managedByEnvironment ? "managed-note" : undefined}
        >
          {note}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
