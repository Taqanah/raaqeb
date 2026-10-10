import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  getRequestHeaders,
  setResponseHeader,
} from "@tanstack/react-start/server";
import { useCallback } from "react";
import { z } from "zod";
import { AccountForm } from "@/admin/onboarding/account-form.tsx";
import {
  type CreateAccountResult,
  createOperatorAccount,
  suggestedPublicAddress,
} from "@/server/onboarding/onboarding.ts";
import { localeSchema } from "@/shared/i18n/locale.ts";
import {
  type OperatorAccountInput,
  operatorAccountSchema,
} from "@/shared/schemas/onboarding.ts";

// The account screen: email, password and the public address
// pre-filled from the request's origin until the browser's own replaces it,
// checked against the request's Origin; the account is created and signed
// in, and the operator lands on the empty monitors list.
const searchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
});

const suggestAddress = createServerFn({ method: "GET" }).handler((): string =>
  suggestedPublicAddress(new Headers(getRequestHeaders()))
);

const create = createServerFn({ method: "POST" })
  .validator(operatorAccountSchema)
  .handler(async ({ context, data }): Promise<CreateAccountResult> => {
    const result = await createOperatorAccount(
      data,
      context,
      new Headers(getRequestHeaders())
    );
    if (result.ok && result.setCookies.length > 0) {
      // The session cookies Better Auth issued, each on the response of this call.
      setResponseHeader("set-cookie", [...result.setCookies]);
    }
    return result;
  });

// A module-level adapter, so the form gets a stable reference.
const createAccount = (input: OperatorAccountInput) => create({ data: input });

export const Route = createFileRoute("/onboarding/account")({
  beforeLoad: ({ context, search }) => {
    if (context.step === "database") {
      throw redirect({ search, to: "/onboarding/database" });
    }
  },
  component: AccountPage,
  loader: () => suggestAddress(),
  validateSearch: (search) => searchSchema.parse(search),
});

function AccountPage() {
  const navigate = useNavigate();
  const suggested = Route.useLoaderData();
  const done = useCallback(() => {
    navigate({ to: "/admin/monitors" }).catch(() => undefined);
  }, [navigate]);
  const { steps } = Route.useRouteContext();
  return (
    <AccountForm
      create={createAccount}
      onCreated={done}
      steps={steps}
      suggestedAddress={suggested}
    />
  );
}
