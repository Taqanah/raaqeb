import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ResetForm } from "@/admin/auth/recovery-forms.tsx";
import { authFor, resetLinkOpen } from "@/server/auth/auth.ts";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { requireOnboardingDone } from "./-onboarding.ts";

// The set-new-password page the reset link opens, from the email
// or from `raaqeb reset-password`. A used or expired link shows the way to a
// new one instead of a form that could only fail; the reset checks it again.
const searchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
  token: z.string().optional().catch(undefined),
});

const readLink = createServerFn({ method: "GET" })
  .validator(z.object({ token: z.string().max(512) }))
  .handler(async ({ context, data }): Promise<boolean> => {
    if (!context.storage) {
      return false;
    }
    try {
      const auth = await authFor(context.storage, context.boot);
      return await resetLinkOpen(auth, data.token, Date.now());
    } catch {
      // The database did not answer: the form shows, and the reset words the failure.
      return true;
    }
  });

export const Route = createFileRoute("/reset-password")({
  // The search comes first: the loader's types are read from it.
  validateSearch: (search) => searchSchema.parse(search),
  beforeLoad: requireOnboardingDone,
  component: ResetPasswordPage,
  loaderDeps: ({ search }) => ({ token: search.token ?? "" }),
  loader: ({ deps }) => readLink({ data: { token: deps.token } }),
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const open = Route.useLoaderData();
  return <ResetForm open={open} token={token ?? ""} />;
}
