import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { z } from "zod";
import { DatabaseForm } from "@/admin/onboarding/database-form.tsx";
import {
  type ChooseDatabaseResult,
  chooseDatabase,
  type TestDatabaseResult,
  testDatabaseUrl,
} from "@/server/onboarding/onboarding.ts";
import { localeSchema } from "@/shared/i18n/locale.ts";
import {
  type DatabaseChoice,
  databaseChoiceSchema,
} from "@/shared/schemas/onboarding.ts";

// The database screen: SQLite by default or a tested Postgres
// URL; continue opens and migrates the choice and writes config.json. Skipped
// when a database is already open.
const searchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
});

const testUrl = createServerFn({ method: "POST" })
  .validator(z.object({ url: z.string().max(2048) }))
  .handler(
    ({ context, data }): Promise<TestDatabaseResult> =>
      testDatabaseUrl(data.url, context)
  );

const choose = createServerFn({ method: "POST" })
  .validator(databaseChoiceSchema)
  .handler(
    async ({ context, data }): Promise<ChooseDatabaseResult> =>
      chooseDatabase(data, context)
  );

// Module-level adapters, so the form gets stable references.
const chooseChoice = (choice: DatabaseChoice) => choose({ data: choice });
const testChoice = (url: string) => testUrl({ data: { url } });

export const Route = createFileRoute("/onboarding/database")({
  beforeLoad: ({ context, search }) => {
    if (context.step === "account") {
      throw redirect({ search, to: "/onboarding/account" });
    }
  },
  component: DatabasePage,
  validateSearch: (search) => searchSchema.parse(search),
});

function DatabasePage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const done = useCallback(
    (next: "account" | "done") => {
      // An adopted database may already hold the account: then sign-in, not the account screen.
      const move =
        next === "done"
          ? navigate({ to: "/sign-in" })
          : navigate({ search, to: "/onboarding/account" });
      move.catch(() => undefined);
    },
    [navigate, search]
  );
  const { steps } = Route.useRouteContext();
  return (
    <DatabaseForm
      choose={chooseChoice}
      onChosen={done}
      steps={steps}
      test={testChoice}
    />
  );
}
