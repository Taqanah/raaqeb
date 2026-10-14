import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { SignInForm } from "@/admin/auth/sign-in-form.tsx";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { hasAuthEmail } from "./-auth-mail.ts";
import { requireOnboardingDone } from "./-onboarding.ts";

// The sign-in page: the form in the install language, or the
// locale `?locale=` names, with the switcher, and whether the
// second step can email a code beside the authenticator app's. The root loader reads
// the search; this route only validates it.
// A locale the install does not ship is ignored, never an error page.
const searchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/sign-in")({
  beforeLoad: requireOnboardingDone,
  component: SignInPage,
  loader: () => hasAuthEmail(),
  validateSearch: (search) => searchSchema.parse(search),
});

function SignInPage() {
  const navigate = useNavigate();
  // A new document: the root reads its language once, and the admin's is the operator's, not this page's.
  const done = useCallback(() => {
    navigate({ reloadDocument: true, to: "/admin" }).catch(() => undefined);
  }, [navigate]);
  return <SignInForm email={Route.useLoaderData()} onSignedIn={done} />;
}
