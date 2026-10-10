import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ForgotForm, NoEmailPage } from "@/admin/auth/recovery-forms.tsx";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { hasAuthEmail } from "./-auth-mail.ts";
import { requireOnboardingDone } from "./-onboarding.ts";

// "Forgot password": the request form when an email channel
// exists, otherwise the page with the reset command. A database that does
// not answer shows the command, which works without email.
const searchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/forgot-password")({
  beforeLoad: requireOnboardingDone,
  component: ForgotPasswordPage,
  loader: () => hasAuthEmail(),
  validateSearch: (search) => searchSchema.parse(search),
});

function ForgotPasswordPage() {
  return Route.useLoaderData() ? <ForgotForm /> : <NoEmailPage />;
}
