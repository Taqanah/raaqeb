/**
 * The general settings page: install language, time
 * zone with the host's named, clock format, calendar, public address, the trusted
 * proxies, locked when `RAAQEB_TRUSTED_PROXIES` set them, the release check
 * switch, and the database row, locked when `DATABASE_URL` set it.
 * A saved language reloads the document, since the catalog is inlined per
 * document.
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
import { formWidth } from "@/admin/shell/page.tsx";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import { useFocusRefused } from "@/admin/shell/use-focus-refused.ts";
import { isLocale, type Locale, locales } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { isOrigin } from "@/shared/schemas/address.ts";
import {
  type Calendar,
  type Clock,
  calendars,
  clocks,
} from "@/shared/schemas/clock.ts";
import {
  type GeneralSaveRefusal,
  type GeneralSettings,
  type GeneralSettingsInput,
  generalSettingsSchema,
  proxyEntries,
} from "@/shared/schemas/settings.ts";
import { Card, CardContent } from "@/shared/ui/card.tsx";
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
import { Switch } from "@/shared/ui/switch.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { CalendarChoice } from "./calendar-choice.tsx";
import { ClockChoice } from "./clock-choice.tsx";
import { LockedField } from "./locked-field.tsx";
import { TimeNow } from "./time-now.tsx";
import { TimeZonePicker } from "./time-zone-picker.tsx";
import { type SaveCall, useDraftSave } from "./use-save.ts";
import { zoneOption } from "./zones.ts";

// A refusal about one field is worded beside it; the save line only says to check the values.
const messages: Readonly<Record<GeneralSaveRefusal, MessageId>> = {
  address_is_page_domain: "setting_invalid",
  invalid: "setting_invalid",
  trusted_proxy_invalid: "setting_invalid",
  unavailable: "setting_unavailable",
};

/** The public address field's words for a refusal; nothing when the refusal is about another field. */
function addressRefusalOf(
  refusal: GeneralSaveRefusal | "unavailable" | undefined,
  address: string
): MessageId | undefined {
  if (refusal === "address_is_page_domain") {
    return "setting_address_is_page_domain";
  }
  if (refusal === "invalid" && !isOrigin(address.trim())) {
    return "setting_public_address_invalid";
  }
}

export interface GeneralFormProps {
  /** Renders the page in a language before it is saved; none for the saved one. */
  readonly onPreviewLanguage?: (locale: Locale | undefined) => void;
  readonly onSaved: (input: GeneralSettingsInput) => void;
  readonly save: SaveCall<GeneralSettingsInput, GeneralSaveRefusal>;
  readonly settings: GeneralSettings;
}

export function GeneralForm({
  onPreviewLanguage,
  onSaved,
  save,
  settings,
}: GeneralFormProps): ReactNode {
  const { locale, t } = useMessages();
  const [releaseCheck, setReleaseCheck] = useState(settings.releaseCheck);
  const [timeZone, setTimeZone] = useState(settings.timeZone);
  const [clock, setClock] = useState<Clock>(settings.clock);
  const [calendar, setCalendar] = useState<Calendar>(settings.calendar);
  const [installLanguage, setInstallLanguage] = useState(
    settings.installLanguage
  );
  const proxies = settings.trustedProxies.entries.join(", ");
  const [typed, setTyped] = useState({
    publicAddress: settings.publicAddress,
    trustedProxies: proxies,
  });
  const draft = useMemo(
    () => ({
      calendar,
      clock,
      installLanguage,
      releaseCheck,
      timeZone,
      ...typed,
    }),
    [calendar, clock, installLanguage, releaseCheck, timeZone, typed]
  );
  const saving = useDraftSave(save, draft, { onSaved });
  const { fail, line, submit } = saving;
  // A refusal marks the field it is about, beside the footer's line, until the next change.
  const refusal = line.kind === "failed" ? line.reason : undefined;
  const addressRefusal = addressRefusalOf(refusal, typed.publicAddress);
  const proxiesRefused = refusal === "trusted_proxy_invalid";
  const formRef = useRef<HTMLFormElement>(null);
  useFocusRefused(formRef, line);
  const onTyped = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.currentTarget;
    setTyped((current) => ({ ...current, [name]: value }));
  }, []);
  // The install language shows on the operator's screens only while they follow it.
  const onLanguage = useCallback(
    (value: unknown) => {
      if (isLocale(value)) {
        setInstallLanguage(value);
      }
      if (settings.operatorLanguage === undefined && isLocale(value)) {
        onPreviewLanguage?.(
          value === settings.installLanguage ? undefined : value
        );
      }
    },
    [onPreviewLanguage, settings.installLanguage, settings.operatorLanguage]
  );
  const onTimeZone = useCallback((zone: string) => {
    setTimeZone(zone);
  }, []);
  // The host zone's offset is read once, as the picker's are.
  const [now] = useState(() => Date.now());
  const onClock = useCallback((value: unknown) => {
    const chosen = clocks.find((each) => each === value);
    if (chosen) {
      setClock(chosen);
    }
  }, []);
  const onCalendar = useCallback((value: unknown) => {
    const chosen = calendars.find((each) => each === value);
    if (chosen) {
      setCalendar(chosen);
    }
  }, []);
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const parsed = generalSettingsSchema.safeParse({
        calendar: form.get("calendar"),
        clock: form.get("clock"),
        installLanguage: form.get("installLanguage"),
        publicAddress: String(form.get("publicAddress") ?? "").trim(),
        releaseCheck,
        timeZone: form.get("timeZone"),
        // Left out while the variable manages it, so the stored entries stay.
        trustedProxies: settings.trustedProxies.managedByEnvironment
          ? undefined
          : proxyEntries(String(form.get("trustedProxies") ?? "")),
      });
      if (!parsed.success) {
        fail("invalid");
        return;
      }
      submit(parsed.data);
    },
    [fail, releaseCheck, settings.trustedProxies, submit]
  );
  return (
    <form
      data-slot="general-form"
      method="post"
      noValidate
      onSubmit={onSubmit}
      ref={formRef}
    >
      {/* Every settings form sits in a card, as the account, sign-in and export forms do. */}
      <Card className={formWidth}>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel id="installLanguage-label">
                {t("setting_install_language")}
              </FieldLabel>
              <Segmented
                aria-labelledby="installLanguage-label"
                data-name="installLanguage"
                defaultValue={settings.installLanguage}
                name="installLanguage"
                onValueChange={onLanguage}
              >
                {locales.map((each) => (
                  <SegmentedItem key={each} lang={each} value={each}>
                    {localeNames[each]}
                  </SegmentedItem>
                ))}
              </Segmented>
            </Field>
            <Field>
              <FieldLabel id="timeZone-label">
                {t("setting_time_zone")}
              </FieldLabel>
              <TimeZonePicker
                defaultValue={settings.timeZone}
                labelledBy="timeZone-label"
                name="timeZone"
                onZone={onTimeZone}
                suggested={[settings.timeZone, settings.hostTimeZone]}
                zones={settings.timeZones}
              />
              <FieldDescription>
                {t("setting_time_zone_host")}{" "}
                {zoneOption(settings.hostTimeZone, locale, now).label}
              </FieldDescription>
              <TimeNow calendar={calendar} clock={clock} timeZone={timeZone} />
            </Field>
            <Field>
              <FieldLabel id="clock-label">{t("setting_clock")}</FieldLabel>
              <ClockChoice
                defaultValue={settings.clock}
                labelledBy="clock-label"
                name="clock"
                onClock={onClock}
              />
            </Field>
            <Field>
              <FieldLabel id="calendar-label">
                {t("setting_calendar")}
              </FieldLabel>
              <CalendarChoice
                defaultValue={settings.calendar}
                labelledBy="calendar-label"
                name="calendar"
                onCalendar={onCalendar}
              />
              <FieldDescription>{t("setting_calendar_hint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="publicAddress">
                {t("setting_public_address")}
              </FieldLabel>
              <Input
                aria-invalid={addressRefusal ? true : undefined}
                autoComplete="url"
                defaultValue={settings.publicAddress}
                id="publicAddress"
                name="publicAddress"
                onChange={onTyped}
                required
                type="url"
                variant="token"
              />
              <FieldDescription>
                {t("setting_public_address_hint")}
              </FieldDescription>
              {addressRefusal ? (
                <FieldError data-error-for="publicAddress">
                  {t(addressRefusal)}
                </FieldError>
              ) : null}
            </Field>
            {settings.trustedProxies.managedByEnvironment ? (
              <LockedField
                id="trustedProxies"
                label={t("setting_trusted_proxies")}
                managedByEnvironment
                value={proxies}
              />
            ) : (
              <Field>
                <FieldLabel htmlFor="trustedProxies">
                  {t("setting_trusted_proxies")}
                </FieldLabel>
                <Input
                  aria-invalid={proxiesRefused ? true : undefined}
                  defaultValue={proxies}
                  id="trustedProxies"
                  name="trustedProxies"
                  onChange={onTyped}
                  variant="token"
                />
                <FieldDescription>
                  {t("setting_trusted_proxies_hint")}{" "}
                  <Token>10.0.0.1, 172.16.0.0/12</Token>
                </FieldDescription>
                {proxiesRefused ? (
                  <FieldError data-error-for="trustedProxies">
                    {t("setting_trusted_proxies_invalid")}
                  </FieldError>
                ) : null}
              </Field>
            )}
            <Field orientation="horizontal">
              <Switch
                checked={releaseCheck}
                id="releaseCheck"
                name="releaseCheck"
                onCheckedChange={setReleaseCheck}
              />
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="releaseCheck">
                  {t("setting_release_check")}
                </FieldLabel>
                <FieldDescription>
                  {t("setting_release_check_hint")}
                </FieldDescription>
              </div>
            </Field>
            <LockedField
              hint={t("setting_database_hint")}
              id="database"
              label={t("setting_database")}
              managedByEnvironment={settings.database.managedByEnvironment}
              value={t(`setting_database_${settings.database.backend}`)}
            />
          </FieldGroup>
        </CardContent>
        <SaveFooter refusals={messages} view={saving} />
      </Card>
    </form>
  );
}
