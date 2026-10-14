/**
 * The account page: three forms. The operator's own
 * language, zone, clock and calendar, each with "as the install" as the empty choice;
 * the email change; the password change, which ends every other session.
 * The email and password changes re-issue the session cookie, so the page
 * reloads to adopt it.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import { useFocusRefused } from "@/admin/shell/use-focus-refused.ts";
import { isLocale, type Locale, locales } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { passwordMaxLength, passwordMinLength } from "@/shared/schemas/auth.ts";
import { calendars, clocks } from "@/shared/schemas/clock.ts";
import {
  type AccountSettings,
  type AccountSettingsInput,
  accountSettingsSchema,
  type EmailChangeInput,
  type EmailChangeRefusal,
  emailChangeSchema,
  type PasswordChangeInput,
  type PasswordChangeRefusal,
  passwordChangeSchema,
  type SaveRefusal,
} from "@/shared/schemas/settings.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { CalendarChoice } from "./calendar-choice.tsx";
import { ClockChoice } from "./clock-choice.tsx";
import { TimeNow } from "./time-now.tsx";
import { TimeZonePicker } from "./time-zone-picker.tsx";
import { type SaveCall, useDraftSave } from "./use-save.ts";

const saveMessages: Readonly<Record<SaveRefusal, MessageId>> = {
  invalid: "setting_invalid",
  unavailable: "setting_unavailable",
};
// A refusal about one field is worded beside it; the save line only says to check the values.
const emailMessages: Readonly<Record<EmailChangeRefusal, MessageId>> = {
  invalid: "setting_invalid",
  same_email: "setting_invalid",
  unavailable: "setting_unavailable",
  wrong_password: "setting_invalid",
};
/** The email field's own words for a refusal: what to type, where the save line says to check. */
const fieldMessages: Readonly<
  Record<Extract<EmailChangeRefusal, "invalid" | "same_email">, MessageId>
> = {
  invalid: "auth_email_invalid",
  same_email: "setting_email_same",
};
const passwordMessages: Readonly<Record<PasswordChangeRefusal, MessageId>> = {
  invalid: "setting_invalid",
  unavailable: "setting_unavailable",
  wrong_password: "setting_invalid",
};

/** The email form once a change went through: nothing typed. */
const emptyEmailChange = { currentPassword: "", email: "" };

/** The password form once a change went through: nothing typed. */
const emptyPasswordChange = { currentPassword: "", newPassword: "" };

/** The empty choice of a select: follow the install. */
const followInstall = "";

export interface OverridesFormProps {
  /** Renders the page in a language before it is saved; none for the saved one. */
  readonly onPreviewLanguage?: (locale: Locale | undefined) => void;
  readonly onSaved: (input: AccountSettingsInput) => void;
  readonly save: SaveCall<AccountSettingsInput, SaveRefusal>;
  readonly settings: AccountSettings;
}

export function OverridesForm({
  onPreviewLanguage,
  onSaved,
  save,
  settings,
}: OverridesFormProps): ReactNode {
  const { t } = useMessages();
  const [language, setLanguage] = useState<string>(
    settings.overrides.operatorLanguage ?? followInstall
  );
  const [timeZone, setTimeZone] = useState(
    settings.overrides.timeZone ?? followInstall
  );
  const [clock, setClock] = useState<string>(
    settings.overrides.clock ?? followInstall
  );
  const [calendar, setCalendar] = useState<string>(
    settings.overrides.calendar ?? followInstall
  );
  const draft = useMemo(
    () => ({ calendar, clock, language, timeZone }),
    [calendar, clock, language, timeZone]
  );
  const saving = useDraftSave(save, draft, { onSaved });
  const { fail, submit } = saving;
  // "As the install" previews the install's language; the saved choice previews nothing.
  const onLanguage = useCallback(
    (value: unknown) => {
      setLanguage(String(value));
      const shown = value === followInstall ? settings.install.language : value;
      const saved =
        settings.overrides.operatorLanguage ?? settings.install.language;
      if (isLocale(shown)) {
        onPreviewLanguage?.(shown === saved ? undefined : shown);
      }
    },
    [onPreviewLanguage, settings]
  );
  const onTimeZone = useCallback((zone: string) => {
    setTimeZone(zone);
  }, []);
  const onClock = useCallback((value: unknown) => {
    setClock(String(value));
  }, []);
  const shownClock =
    clocks.find((each) => each === clock) ?? settings.install.clock;
  const onCalendar = useCallback((value: unknown) => {
    setCalendar(String(value));
  }, []);
  const shownCalendar =
    calendars.find((each) => each === calendar) ?? settings.install.calendar;
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const chosen = (name: string) => {
        const value = form.get(name);
        return value === followInstall || value === null ? undefined : value;
      };
      const parsed = accountSettingsSchema.safeParse({
        calendar: chosen("calendar"),
        clock: chosen("clock"),
        operatorLanguage: chosen("operatorLanguage"),
        timeZone: chosen("timeZone"),
      });
      if (!parsed.success) {
        fail("invalid");
        return;
      }
      submit(parsed.data);
    },
    [fail, submit]
  );
  return (
    <form data-slot="overrides-form" method="post" onSubmit={onSubmit}>
      <Card>
        <CardHeader divided>
          <CardTitle>{t("setting_overrides_title")}</CardTitle>
          <CardDescription>{t("setting_overrides_lead")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel id="operatorLanguage-label">
                {t("setting_operator_language")}
              </FieldLabel>
              {/* "As the install" names the language it follows, under the words. */}
              <Segmented
                aria-labelledby="operatorLanguage-label"
                data-name="operatorLanguage"
                defaultValue={
                  settings.overrides.operatorLanguage ?? followInstall
                }
                name="operatorLanguage"
                onValueChange={onLanguage}
              >
                <SegmentedItem
                  hint={localeNames[settings.install.language]}
                  value={followInstall}
                >
                  {t("setting_follow_install")}
                </SegmentedItem>
                {locales.map((locale) => (
                  <SegmentedItem key={locale} lang={locale} value={locale}>
                    {localeNames[locale]}
                  </SegmentedItem>
                ))}
              </Segmented>
            </Field>
            <Field>
              <FieldLabel id="operatorTimeZone-label">
                {t("setting_time_zone")}
              </FieldLabel>
              <TimeZonePicker
                defaultValue={settings.overrides.timeZone ?? followInstall}
                follow={{
                  label: t("setting_follow_install"),
                  zone: settings.install.timeZone,
                }}
                labelledBy="operatorTimeZone-label"
                name="timeZone"
                onZone={onTimeZone}
                suggested={[
                  settings.install.timeZone,
                  ...(settings.overrides.timeZone
                    ? [settings.overrides.timeZone]
                    : []),
                ]}
                zones={settings.timeZones}
              />
              <TimeNow
                calendar={shownCalendar}
                clock={shownClock}
                timeZone={
                  timeZone === followInstall
                    ? settings.install.timeZone
                    : timeZone
                }
              />
            </Field>
            <Field>
              <FieldLabel id="operatorClock-label">
                {t("setting_clock")}
              </FieldLabel>
              <ClockChoice
                defaultValue={settings.overrides.clock ?? followInstall}
                follow={{ clock: settings.install.clock, value: followInstall }}
                labelledBy="operatorClock-label"
                name="clock"
                onClock={onClock}
              />
            </Field>
            <Field>
              <FieldLabel id="operatorCalendar-label">
                {t("setting_calendar")}
              </FieldLabel>
              <CalendarChoice
                defaultValue={settings.overrides.calendar ?? followInstall}
                follow={{
                  calendar: settings.install.calendar,
                  value: followInstall,
                }}
                labelledBy="operatorCalendar-label"
                name="calendar"
                onCalendar={onCalendar}
              />
            </Field>
          </FieldGroup>
        </CardContent>
        <SaveFooter refusals={saveMessages} view={saving} />
      </Card>
    </form>
  );
}

export interface EmailFormProps {
  readonly change: SaveCall<EmailChangeInput, EmailChangeRefusal>;
  readonly email: string;
  readonly onChanged: () => void;
}

export function EmailForm({
  change,
  email,
  onChanged,
}: EmailFormProps): ReactNode {
  const { t } = useMessages();
  const [typed, setTyped] = useState(emptyEmailChange);
  const onTyped = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.currentTarget;
    setTyped((current) => ({ ...current, [name]: value }));
  }, []);
  const formRef = useRef<HTMLFormElement>(null);
  // A password typed once is not left in the page, nor the address it moved to.
  const changed = useCallback(() => {
    formRef.current?.reset();
    setTyped(emptyEmailChange);
    onChanged();
  }, [onChanged]);
  const saving = useDraftSave(change, typed, {
    emptied: emptyEmailChange,
    onSaved: changed,
  });
  const { fail, line, submit } = saving;
  const reason = line.kind === "failed" ? line.reason : undefined;
  const currentRefusal = currentRefusalOf(reason, typed.currentPassword);
  // A wrong or empty password is worded beside the password, the rest beside the address.
  const refusal: MessageId | undefined =
    reason === "same_email" ||
    (reason === "invalid" &&
      !emailChangeSchema.shape.email.safeParse(typed.email.trim()).success)
      ? fieldMessages[reason]
      : undefined;
  useFocusRefused(formRef, line);
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const parsed = emailChangeSchema.safeParse({
        currentPassword: String(form.get("currentPassword") ?? ""),
        email: String(form.get("email") ?? "").trim(),
      });
      if (!parsed.success) {
        fail("invalid");
        return;
      }
      submit(parsed.data);
    },
    [fail, submit]
  );
  return (
    <form
      data-slot="email-form"
      method="post"
      noValidate
      onSubmit={onSubmit}
      ref={formRef}
    >
      <Card>
        <CardHeader divided>
          <CardTitle id="emailChange-title">
            {t("setting_email_change")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <FieldDescription>
              {t("auth_email")}: <Token>{email}</Token>
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor="email">{t("setting_email_new")}</FieldLabel>
              <Input
                aria-invalid={refusal ? true : undefined}
                autoComplete="email"
                dir="ltr"
                id="email"
                name="email"
                onChange={onTyped}
                required
                type="email"
              />
              {refusal ? (
                <FieldError data-error-for="email">{t(refusal)}</FieldError>
              ) : null}
            </Field>
            <Field>
              <FieldLabel
                htmlFor="emailCurrentPassword"
                id="emailCurrentPassword-label"
              >
                {t("setting_password_current")}
              </FieldLabel>
              <Input
                aria-invalid={currentRefusal ? true : undefined}
                // Named with its card, since the password card has a field of the same label.
                aria-labelledby="emailChange-title emailCurrentPassword-label"
                autoComplete="current-password"
                id="emailCurrentPassword"
                name="currentPassword"
                onChange={onTyped}
                required
                type="password"
              />
              {currentRefusal ? (
                <FieldError data-error-for="currentPassword">
                  {t(currentRefusal)}
                </FieldError>
              ) : null}
            </Field>
          </FieldGroup>
        </CardContent>
        <SaveFooter
          fresh
          label={t("setting_email_change")}
          refusals={emailMessages}
          view={saving}
        />
      </Card>
    </form>
  );
}

/** The current password field's words for a refusal; nothing when the refusal is about another field. */
function currentRefusalOf(
  refusal: PasswordChangeRefusal | EmailChangeRefusal | undefined,
  current: string
): MessageId | undefined {
  if (refusal === "wrong_password") {
    return "setting_password_wrong";
  }
  if (refusal === "invalid" && current === "") {
    return "auth_password_required";
  }
}

export interface PasswordFormProps {
  readonly change: SaveCall<PasswordChangeInput, PasswordChangeRefusal>;
  readonly onChanged: () => void;
}

export function PasswordForm({
  change,
  onChanged,
}: PasswordFormProps): ReactNode {
  const { t } = useMessages();
  const [typed, setTyped] = useState(emptyPasswordChange);
  const onTyped = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.currentTarget;
    setTyped((current) => ({ ...current, [name]: value }));
  }, []);
  const formRef = useRef<HTMLFormElement>(null);
  // Neither password is left in the fields once it changed.
  const changed = useCallback(() => {
    formRef.current?.reset();
    setTyped(emptyPasswordChange);
    onChanged();
  }, [onChanged]);
  const saving = useDraftSave(change, typed, {
    emptied: emptyPasswordChange,
    onSaved: changed,
  });
  const { fail, line, submit } = saving;
  const refusal = line.kind === "failed" ? line.reason : undefined;
  const currentRefusal = currentRefusalOf(refusal, typed.currentPassword);
  const newRefused =
    refusal === "invalid" &&
    !passwordChangeSchema.shape.newPassword.safeParse(typed.newPassword)
      .success;
  useFocusRefused(formRef, line);
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const parsed = passwordChangeSchema.safeParse({
        currentPassword: String(form.get("currentPassword") ?? ""),
        newPassword: String(form.get("newPassword") ?? ""),
      });
      if (!parsed.success) {
        fail("invalid");
        return;
      }
      submit(parsed.data);
    },
    [fail, submit]
  );
  return (
    <form
      data-slot="password-form"
      method="post"
      noValidate
      onSubmit={onSubmit}
      ref={formRef}
    >
      <Card>
        <CardHeader divided>
          <CardTitle id="passwordChange-title">
            {t("setting_password_change")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="currentPassword" id="currentPassword-label">
                {t("setting_password_current")}
              </FieldLabel>
              <Input
                aria-invalid={currentRefusal ? true : undefined}
                aria-labelledby="passwordChange-title currentPassword-label"
                autoComplete="current-password"
                id="currentPassword"
                name="currentPassword"
                onChange={onTyped}
                required
                type="password"
              />
              {currentRefusal ? (
                <FieldError data-error-for="currentPassword">
                  {t(currentRefusal)}
                </FieldError>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="newPassword">
                {t("setting_password_new")}
              </FieldLabel>
              <Input
                aria-invalid={newRefused ? true : undefined}
                autoComplete="new-password"
                id="newPassword"
                maxLength={passwordMaxLength}
                minLength={passwordMinLength}
                name="newPassword"
                onChange={onTyped}
                required
                type="password"
              />
              <FieldDescription>{t("setting_password_note")}</FieldDescription>
              {newRefused ? (
                <FieldError data-error-for="newPassword">
                  {t("auth_password_length")}
                </FieldError>
              ) : null}
            </Field>
          </FieldGroup>
        </CardContent>
        <SaveFooter
          fresh
          label={t("setting_password_change")}
          refusals={passwordMessages}
          view={saving}
        />
      </Card>
    </form>
  );
}
