/**
 * The pieces every section of the monitor form shares: a section card, the
 * refusal under a field, a text field, a switch and a radio group bound to
 * a draft field by name. Every input names its draft field (draft.ts
 * `withField`), so one handler serves the whole form.
 */
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { formatUnit, type Unit } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { Switch } from "@/shared/ui/switch.tsx";
import type { FieldErrors, MonitorDraft } from "./draft.ts";

/** An input, a select or a text area naming its draft field. */
export type FieldChange = (
  event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
) => void;

/** A choice or a switch naming its draft field. */
export type FieldChoice = (name: string, value: string) => void;
export type FlagChange = (
  name:
    | "followRedirects"
    | "ignoreTlsErrors"
    | "ownRetention"
    | "reminder"
    | "renewHeartbeatUrl"
    | "tlsExpiry",
  on: boolean
) => void;

/** What every section gets: the draft, its refusals and the three ways to change it. */
export interface SectionProps {
  readonly draft: MonitorDraft;
  readonly errors: FieldErrors;
  readonly onChoice: FieldChoice;
  readonly onField: FieldChange;
  readonly onFlag: FlagChange;
}

export function Section({
  children,
  description,
  footer,
  slot,
  title,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  /** The form's save, on its last section. */
  readonly footer?: ReactNode;
  readonly slot: string;
  readonly title: string;
}): ReactNode {
  return (
    <Card data-section={slot}>
      <CardHeader divided>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">{children}</CardContent>
      {footer}
    </Card>
  );
}

/** The refusal of one field, worded through the catalog; nothing when the field is fine. */
export function Problem({
  errors,
  path,
}: {
  readonly errors: FieldErrors;
  readonly path: string;
}): ReactNode {
  const { t } = useMessages();
  const error = errors[path];
  if (!error) {
    return null;
  }
  return (
    <FieldError data-error-for={path}>{t(error.id, error.values)}</FieldError>
  );
}

/** One text field with its label, its refusal and an optional line under it; `path` is the posted input's path the refusal is keyed by. */
export function TextField({
  dir,
  errors,
  hint,
  label,
  name,
  onField,
  path,
  value,
  ...rest
}: {
  readonly autoComplete?: "off" | "new-password";
  readonly dir?: "auto" | "ltr";
  readonly errors: FieldErrors;
  readonly hint?: string;
  readonly inputMode?: "numeric";
  readonly label: string;
  readonly list?: string;
  readonly name: string;
  readonly onField: FieldChange;
  readonly path: string;
  readonly placeholder?: string;
  readonly type?: "password";
  readonly unit?: string;
  readonly value: string;
  readonly variant?: "token";
}): ReactNode {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Input
        aria-invalid={errors[path] ? true : undefined}
        dir={dir}
        id={name}
        name={name}
        onChange={onField}
        spellCheck={dir === "ltr" ? false : undefined}
        value={value}
        {...rest}
      />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      <Problem errors={errors} path={path} />
    </Field>
  );
}

/** A switch with its label and hint, bound to a boolean draft field. */
export function FlagField({
  checked,
  disabled,
  hint,
  label,
  name,
  onFlag,
  slot,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly hint?: string;
  readonly label: string;
  readonly name: Parameters<FlagChange>[0];
  readonly onFlag: FlagChange;
  /** A `data-slot` for the switch itself, where a test needs to find it. */
  readonly slot?: string;
}): ReactNode {
  const change = useCallback((on: boolean) => onFlag(name, on), [name, onFlag]);
  return (
    <Field orientation="horizontal">
      <Switch
        checked={checked}
        disabled={disabled}
        id={name}
        name={name}
        onCheckedChange={change}
        {...(slot && { "data-slot": slot })}
      />
      <div className="flex flex-col gap-0.5">
        <FieldLabel className={cn(disabled && "opacity-50")} htmlFor={name}>
          {label}
        </FieldLabel>
        {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      </div>
    </Field>
  );
}

/** Radio choices bound to a draft field, each with its label and an optional line under it. */
export function ChoiceField({
  choices,
  className,
  label,
  name,
  onChoice,
  value,
}: {
  readonly choices: readonly {
    readonly hint?: string;
    readonly label: string;
    readonly value: string;
  }[];
  /** The track's layout, where many options need rows on a phone. */
  readonly className?: string;
  readonly label: string;
  readonly name: string;
  readonly onChoice: FieldChoice;
  readonly value: string;
}): ReactNode {
  const change = useCallback(
    (chosen: unknown) => onChoice(name, String(chosen)),
    [name, onChoice]
  );
  return (
    <Field>
      <FieldLabel id={`${name}-label`}>{label}</FieldLabel>
      {/* Every choice in view and one click away; a hint is the option's second line. */}
      <Segmented
        aria-labelledby={`${name}-label`}
        className={className}
        data-name={name}
        name={name}
        onValueChange={change}
        value={value}
      >
        {choices.map((choice) => (
          <SegmentedItem
            hint={choice.hint}
            key={choice.value}
            value={choice.value}
          >
            {choice.label}
          </SegmentedItem>
        ))}
      </Segmented>
    </Field>
  );
}

/** A duration as the interval selects word it: whole hours, minutes or seconds, in full. */
export function intervalLabel(
  locale: Parameters<typeof formatUnit>[0],
  ms: number
) {
  const units: readonly [Unit, number][] = [
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1000],
  ];
  const [unit, size] = units.find(([, step]) => ms % step === 0) ?? [
    "second",
    1000,
  ];
  return formatUnit(locale, ms / size, unit, "long");
}
