import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { SignOutForm } from "@/admin/auth/sign-out-form.tsx";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { requireOnboardingDone } from "./-onboarding.ts";

// The sign-out page: one button, so a GET never ends a session.
// A locale the install does not ship is ignored, never an error page.
const searchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/sign-out")({
  beforeLoad: requireOnboardingDone,
  component: SignOutPage,
  validateSearch: (search) => searchSchema.parse(search),
});

function SignOutPage() {
  const navigate = useNavigate();
  const done = useCallback(() => {
    navigate({ to: "/sign-in" }).catch(() => undefined);
  }, [navigate]);
  return <SignOutForm onSignedOut={done} />;
}
