/**
 * Content in the admin (CONTEXT.md "Content"): what the operator
 * reads of it, in the operator language, else the install language, else
 * the locale it is written in; and the field that writes it, one input per
 * locale, the required one first and the others marked optional. The
 * install language, which install-wide content requires, comes from the
 * admin layout.
 */
import {
  type ChangeEvent,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
} from "react";
import {
  defaultLocale,
  directionOf,
  type Locale,
  locales,
} from "@/shared/i18n/locale.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type Content,
  type ContentDraft,
  contentIn,
} from "@/shared/schemas/content.ts";
import { cn } from "@/shared/ui/cn.ts";
import { FieldDescription, FieldError } from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { Label } from "@/shared/ui/label.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import { Textarea } from "@/shared/ui/textarea.tsx";

const InstallLanguage = createContext<Locale>(defaultLocale);

/** Gives every admin page the install language; the admin layout wraps them in it. */
export function InstallLanguageProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: Locale;
}): ReactNode {
  return <InstallLanguage value={value}>{children}</InstallLanguage>;
}

/** The install language, whose text install-wide content requires. */
export function useInstallLanguage(): Locale {
  return useContext(InstallLanguage);
}

/** Reads content as the operator does: their language's text, else the install language's, else the locale that has some. */
export function useContentIn(): (content: Content | undefined) => string {
  const { locale } = useMessages();
  const install = useInstallLanguage();
  return (content) => contentIn(content, locale, install);
}

/** One piece of content as the operator reads it, isolated from the text around it. */
export function ContentText({
  content,
}: {
  readonly content: Content | undefined;
}): ReactNode {
  return <bdi>{useContentIn()(content)}</bdi>;
}

/** What every content input shares: the content as typed, the rule it is held to and the change it reports. */
interface ContentInputProps {
  /** The inputs' ids and names are this with each locale after a dash. */
  readonly id: string;
  /** Whether each locale stands alone with none required, as a status name does. */
  readonly independent?: boolean;
  /** The most characters each locale's text may hold. */
  readonly max: number;
  readonly onChange: (value: ContentDraft) => void;
  /** Whether the content may be left empty in every locale. */
  readonly optional?: boolean;
  /** The locale whose text a save requires, shown first; optional content needs it once any locale holds text. */
  readonly required: Locale;
  readonly value: ContentDraft;
}

/** The locales in the order a form shows them, the required one first, each with whether its input breaks the rule and whether it is marked optional. */
function inputsOf({
  independent = false,
  max,
  optional = false,
  required,
  value,
}: ContentInputProps): {
  readonly breaks: boolean;
  readonly locale: Locale;
  readonly optional: boolean;
}[] {
  const written = locales.some((each) => value[each].trim() !== "");
  return [required, ...locales.filter((each) => each !== required)].map(
    (locale) => {
      const text = value[locale].trim();
      const needed = locale === required && !independent;
      const missing = needed && text === "" && (written || !optional);
      return {
        breaks: text.length > max || missing,
        locale,
        optional: !needed,
      };
    }
  );
}

/** The change handler of a group of inputs named `<id>-<locale>`. */
function useOnText({ id, onChange, value }: ContentInputProps) {
  return useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const locale = locales.find(
        (each) => event.currentTarget.name === `${id}-${each}`
      );
      if (locale) {
        onChange({ ...value, [locale]: event.currentTarget.value });
      }
    },
    [id, onChange, value]
  );
}

/** One piece of content as bare inputs stacked in a column, for a row too tight for a field's labels; each input names its locale and shows it while empty. */
export function ContentInputs(
  props: ContentInputProps & {
    readonly className?: string;
    /** Whether the row is refused; the inputs that break the rule are marked. */
    readonly invalid: boolean;
    readonly label: string;
  }
): ReactNode {
  const { t } = useMessages();
  const onText = useOnText(props);
  const { className, id, invalid, label, value } = props;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      {inputsOf(props).map(({ breaks, locale, optional }) => {
        const language = `${label} · ${localeNames[locale]}`;
        const named = optional
          ? `${language} · ${t("app_optional")}`
          : language;
        return (
          <Input
            aria-invalid={invalid && breaks ? true : undefined}
            aria-label={named}
            dir={directionOf(locale)}
            key={locale}
            lang={locale}
            name={`${id}-${locale}`}
            onChange={onText}
            placeholder={named}
            value={value[locale]}
          />
        );
      })}
    </div>
  );
}

/** One piece of content as a field: its label over one labelled input per locale, each in its own direction, then its hint and its refusal. */
export function ContentField(
  props: ContentInputProps & {
    /** Shown under the inputs. */
    readonly description?: ReactNode;
    /** The field's refusal, shown under it; the inputs that break the rule are marked. */
    readonly error?: string | undefined;
    readonly label: ReactNode;
    /** A textarea of this many rows; an input without. */
    readonly multiline?: number;
    /** What an empty input shows, by locale. */
    readonly placeholders?: Readonly<Partial<Record<Locale, string>>>;
  }
): ReactNode {
  const { t } = useMessages();
  const onText = useOnText(props);
  const { description, error, id, label, multiline, placeholders } = props;
  return (
    <fieldset className="flex min-w-0 flex-col gap-3" data-slot="content-field">
      <legend className="mb-2 font-medium text-sm leading-snug">{label}</legend>
      {inputsOf(props).map(({ breaks, locale, optional }) => {
        const inputId = `${id}-${locale}`;
        const input = {
          "aria-invalid": error && breaks ? true : undefined,
          dir: directionOf(locale),
          id: inputId,
          lang: locale,
          name: inputId,
          onChange: onText,
          placeholder: placeholders?.[locale],
          value: props.value[locale],
        };
        return (
          <div className="flex flex-col gap-1.5" key={locale}>
            <Label
              className="gap-1.5 font-normal text-muted-foreground text-xs"
              htmlFor={inputId}
            >
              <span dir={directionOf(locale)} lang={locale}>
                {localeNames[locale]}
              </span>
              {optional ? <span>· {t("app_optional")}</span> : null}
            </Label>
            {multiline ? (
              <Textarea {...input} rows={multiline} />
            ) : (
              <Input {...input} />
            )}
          </div>
        );
      })}
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </fieldset>
  );
}
