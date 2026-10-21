import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { z } from "zod";
import { InvitationForm } from "@/admin/auth/invitation-form.tsx";
import { readInvitation } from "@/server/auth/invitation.ts";
import { localeSchema } from "@/shared/i18n/locale.ts";
import type { InvitationView } from "@/shared/schemas/team.ts";
import { requireOnboardingDone } from "./-onboarding.ts";
import { readSsoOfferFn } from "./-sso.ts";

// The page an invitation's link opens (CONTEXT.md "Invitation"): what it
// offers and the form that accepts it, in the install language or the one
// `?locale=` names. A closed link shows the way on instead of a form that
// could only fail; accepting checks it again.
const searchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
  token: z.string().optional().catch(undefined),
});

const readInvitationFn = createServerFn({ method: "GET" })
  .validator(z.object({ token: z.string().max(200) }))
  .handler(
    ({ context, data }): Promise<InvitationView> =>
      readInvitation(context.storage, data.token, Date.now())
  );

export const Route = createFileRoute("/invitation")({
  // The search comes first: the loader's types are read from it.
  validateSearch: (search) => searchSchema.parse(search),
  beforeLoad: requireOnboardingDone,
  component: InvitationPage,
  loaderDeps: ({ search }) => ({ token: search.token ?? "" }),
  loader: async ({ deps }) => {
    const [view, sso] = await Promise.all([
      readInvitationFn({ data: { token: deps.token.slice(0, 200) } }),
      readSsoOfferFn(),
    ]);
    return { sso, view };
  },
});

function InvitationPage() {
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  // A new document: the admin renders in the new operator's language, not this page's.
  const accepted = useCallback(() => {
    navigate({ reloadDocument: true, to: "/admin" }).catch(() => undefined);
  }, [navigate]);
  const { sso, view } = Route.useLoaderData();
  return (
    <InvitationForm
      onAccepted={accepted}
      sso={sso}
      token={token ?? ""}
      view={view}
    />
  );
}
