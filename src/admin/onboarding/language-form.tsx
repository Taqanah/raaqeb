/**
 * The language screen: the install language, Arabic by
 * default, as one radio per locale named in itself. A plain GET form, so the
 * choice becomes ?locale= on the next screen with no script. The cards are
 * the language choice, so the switcher under the card is left out.
 */
import type { ReactNode } from "react";
import { AuthPage } from "@/admin/auth/auth-page.tsx";
import { directionOf, locales } from "@/shared/i18n/locale.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Button } from "@/shared/ui/button.tsx";
import { FieldDescription, FieldGroup } from "@/shared/ui/field.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import { OptionCard, OptionCards } from "@/shared/ui/option-card.tsx";

export interface LanguageFormProps {
  /** The screen the choice leads to: the database screen, or the account screen when a database is already open. */
  readonly nextPath: "/onboarding/database" | "/onboarding/account";
  /** How many screens this install's onboarding has. */
  readonly steps: number;
}

export function LanguageForm({
  nextPath,
  steps,
}: LanguageFormProps): ReactNode {
  const { locale, t } = useMessages();
  return (
    <AuthPage
      step={{ current: 1, total: steps }}
      switcher={false}
      title={t("onboarding_language_title")}
    >
      <form action={nextPath} method="get">
        <FieldGroup>
          <FieldDescription>{t("onboarding_language_lead")}</FieldDescription>
          {/* Each language a large card in its own script and direction. */}
          <OptionCards
            aria-label={t("onboarding_language_title")}
            className="grid-cols-2"
            data-name="locale"
            defaultValue={locale}
            name="locale"
          >
            {locales.map((value) => (
              <OptionCard
                className="h-20 items-center justify-center"
                key={value}
                value={value}
              >
                <span
                  className="font-semibold text-xl"
                  dir={directionOf(value)}
                  lang={value}
                >
                  {localeNames[value]}
                </span>
              </OptionCard>
            ))}
          </OptionCards>
          <Button type="submit">{t("onboarding_continue")}</Button>
        </FieldGroup>
      </form>
    </AuthPage>
  );
}
