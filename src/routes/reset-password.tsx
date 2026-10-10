import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ResetForm } from "@/admin/auth/recovery-forms.tsx";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { requireOnboardingDone } from "./-onboarding.ts";

// The set-new-password page the reset link opens, from the email
// or from `raaqeb reset-password`. The token is checked when it is used.
const searchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
  token: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/reset-password")({
  beforeLoad: requireOnboardingDone,
  component: ResetPasswordPage,
  validateSearch: (search) => searchSchema.parse(search),
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  return <ResetForm token={token ?? ""} />;
}
