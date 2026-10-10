/**
 * The storage settings page: the
 * install-wide retention in days and the size budget in megabytes, empty
 * for unlimited, with the used size and, on SQLite, the free disk and the
 * reserve it keeps; on Postgres with no budget, why it runs unlimited.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useState,
} from "react";
import { formWidth } from "@/admin/shell/page.tsx";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import { formatUnit, normalizeDigits } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  megabyte,
  reserveBytes,
  type SaveRefusal,
  type StorageSettings,
  type StorageSettingsInput,
  storageSettingsSchema,
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
import { type SaveCall, useDraftSave } from "./use-save.ts";

const messages: Readonly<Record<SaveRefusal, MessageId>> = {
  invalid: "setting_invalid",
  unavailable: "setting_unavailable",
};

const gigabyte = 1024 * megabyte;
const digitsOnly = /^\d+$/;

/** A size in megabytes, or in gigabytes from one up. */
function sizeText(locale: Locale, bytes: number): string {
  return bytes >= gigabyte
    ? formatUnit(locale, bytes / gigabyte, "gigabyte")
    : formatUnit(locale, bytes / megabyte, "megabyte");
}

/** A typed whole number, Arabic-Indic digits read; nothing when empty, NaN when not one. */
function typedNumber(typed: string): number | undefined {
  const trimmed = normalizeDigits(typed).trim();
  if (trimmed === "") {
    return;
  }
  return digitsOnly.test(trimmed) ? Number(trimmed) : Number.NaN;
}

type StorageField = keyof StorageSettingsInput;

export interface StorageFormProps {
  readonly save: SaveCall<StorageSettingsInput, SaveRefusal>;
  readonly settings: StorageSettings;
}

export function StorageForm({ save, settings }: StorageFormProps): ReactNode {
  const { locale, t } = useMessages();
  const [typed, setTyped] = useState({
    retentionDays: String(settings.retentionDays),
    sizeBudget:
      settings.sizeBudgetBytes === undefined
        ? ""
        : String(settings.sizeBudgetBytes / megabyte),
  });
  const onTyped = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.currentTarget;
    setTyped((current) => ({ ...current, [name]: value }));
  }, []);
  const saving = useDraftSave(save, typed);
  const { fail, submit } = saving;
  const [refused, setRefused] = useState<ReadonlySet<StorageField>>(new Set());
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const budget = typedNumber(String(form.get("sizeBudget") ?? ""));
      const parsed = storageSettingsSchema.safeParse({
        retentionDays: typedNumber(String(form.get("retentionDays") ?? "")),
        sizeBudgetBytes: budget === undefined ? undefined : budget * megabyte,
      });
      if (!parsed.success) {
        setRefused(
          new Set(
            parsed.error.issues.flatMap((issue) => {
              const [field] = issue.path;
              return field === "retentionDays" || field === "sizeBudgetBytes"
                ? [field]
                : [];
            })
          )
        );
        fail("invalid");
        return;
      }
      setRefused(new Set());
      submit(parsed.data);
    },
    [fail, submit]
  );
  const sqlite = settings.backend === "sqlite";
  return (
    <form data-slot="storage-form" method="post" noValidate onSubmit={onSubmit}>
      {/* Every settings form sits in a card, as the account, sign-in and export forms do. */}
      <Card className={formWidth}>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="retentionDays">
                {t("setting_retention_days")}
              </FieldLabel>
              <Input
                aria-invalid={refused.has("retentionDays") ? true : undefined}
                defaultValue={typed.retentionDays}
                id="retentionDays"
                inputMode="numeric"
                name="retentionDays"
                onChange={onTyped}
                unit={t("monitor_unit_days")}
              />
              <FieldDescription>{t("setting_retention_hint")}</FieldDescription>
              {refused.has("retentionDays") ? (
                <FieldError>{t("setting_retention_invalid")}</FieldError>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="sizeBudget">
                {t("setting_size_budget")}
              </FieldLabel>
              <Input
                aria-invalid={refused.has("sizeBudgetBytes") ? true : undefined}
                defaultValue={typed.sizeBudget}
                id="sizeBudget"
                inputMode="numeric"
                name="sizeBudget"
                onChange={onTyped}
                unit={t("setting_unit_megabytes")}
              />
              <FieldDescription>
                {t("setting_size_budget_hint")}
              </FieldDescription>
              {refused.has("sizeBudgetBytes") ? (
                <FieldError>{t("setting_size_budget_invalid")}</FieldError>
              ) : null}
            </Field>
            <div className="flex flex-col gap-1 text-sm">
              {settings.usedBytes === undefined ? null : (
                <p data-slot="used-size">
                  {t("setting_used_size", {
                    size: sizeText(locale, settings.usedBytes),
                  })}
                </p>
              )}
              {settings.freeBytes === undefined ? null : (
                <p data-slot="free-disk">
                  {t("setting_free_disk", {
                    size: sizeText(locale, settings.freeBytes),
                  })}
                </p>
              )}
              {sqlite ? (
                <p className="text-muted-foreground">
                  {t("setting_reserve_note", {
                    size: sizeText(locale, reserveBytes),
                  })}
                </p>
              ) : null}
              {sqlite &&
              settings.freeBytes !== undefined &&
              settings.freeBytes < reserveBytes ? (
                <p className="text-status-down" data-slot="reserve-low">
                  {t("setting_reserve_low")}
                </p>
              ) : null}
              {sqlite || settings.sizeBudgetBytes !== undefined ? null : (
                <p className="text-muted-foreground" data-slot="postgres-note">
                  {t("setting_postgres_unlimited")}
                </p>
              )}
            </div>
          </FieldGroup>
        </CardContent>
        <SaveFooter refusals={messages} view={saving} />
      </Card>
    </form>
  );
}
