import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { LanguageForm } from "@/admin/onboarding/language-form.tsx";
import { localeSchema } from "@/shared/i18n/locale.ts";

// The language screen: opens in Arabic; the choice travels as
// ?locale= to the next screen, and the account screen stores it. The root
// loader reads the search; this route only validates it.
const searchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/onboarding/")({
  component: LanguagePage,
  validateSearch: (search) => searchSchema.parse(search),
});

function LanguagePage() {
  const { step, steps } = Route.useRouteContext();
  // With a database already open (DATABASE_URL, or a resumed onboarding) the database screen is skipped.
  return (
    <LanguageForm
      nextPath={
        step === "account" ? "/onboarding/account" : "/onboarding/database"
      }
      steps={steps}
    />
  );
}
