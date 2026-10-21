import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { SignInForm } from "@/admin/auth/sign-in-form.tsx";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { ssoFailureOf } from "@/shared/schemas/sso.ts";
import { hasAuthEmail } from "./-auth-mail.ts";
import { requireOnboardingDone } from "./-onboarding.ts";
import { readSsoOfferFn } from "./-sso.ts";

// The sign-in page: the form in the install language, or the
// locale `?locale=` names, with the switcher, whether the
// second step can email a code beside the authenticator app's, and the
// identity provider's button while single sign-on is on. The root loader
// reads the search; this route only validates it. `?error=` is the code
// the provider's callback came back with.
// A locale the install does not ship is ignored, never an error page.
const searchSchema = z.object({
  error: z.string().max(100).optional().catch(undefined),
  locale: localeSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/sign-in")({
  beforeLoad: requireOnboardingDone,
  component: SignInPage,
  loader: async () => {
    const [email, sso] = await Promise.all([hasAuthEmail(), readSsoOfferFn()]);
    return { email, sso };
  },
  validateSearch: (search) => searchSchema.parse(search),
});

function SignInPage() {
  const navigate = useNavigate();
  const { email, sso } = Route.useLoaderData();
  const { error } = Route.useSearch();
  // A new document: the root reads its language once, and the admin's is the operator's, not this page's.
  const done = useCallback(() => {
    navigate({ reloadDocument: true, to: "/admin" }).catch(() => undefined);
  }, [navigate]);
  return (
    <SignInForm
      email={email}
      onSignedIn={done}
      sso={sso}
      ssoFailure={ssoFailureOf(error)}
    />
  );
}
