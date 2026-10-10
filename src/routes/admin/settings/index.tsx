import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { GeneralForm } from "@/admin/settings/general-form.tsx";
import { useLanguagePreview } from "@/admin/settings/language-preview.ts";
import { CardsSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { operatorMiddleware } from "@/routes/-admin.ts";
import {
  readGeneralSettings,
  saveGeneralSettings,
} from "@/server/settings/general.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import {
  type GeneralSaveResult,
  type GeneralSettings,
  type GeneralSettingsInput,
  generalSettingsSchema,
  settingsSearchSchema,
} from "@/shared/schemas/settings.ts";

// The general page: every field round-trips through these two server functions.
const readGeneral = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<GeneralSettings> =>
      readGeneralSettings(context.storage, context.boot)
  );

const saveGeneral = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(generalSettingsSchema)
  .handler(
    ({ context, data }): Promise<GeneralSaveResult> =>
      saveGeneralSettings(context.storage, data, context.boot)
  );

export const Route = createFileRoute("/admin/settings/")({
  // A language picked and not yet saved renders the page in it.
  validateSearch: settingsSearchSchema,
  component: GeneralPage,
  pendingComponent: CardsSkeleton,
  loader: ({ abortController: { signal } }) => readGeneral({ signal }),
});

function GeneralPage() {
  const settings = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const show = useCallback(
    (locale: Locale | undefined) =>
      navigate({ replace: true, search: { locale } }),
    [navigate]
  );
  const preview = useLanguagePreview(show);
  // Through useServerFn, a redirect the session check throws navigates (an expired session goes to sign-in).
  const saveFn = useServerFn(saveGeneral);
  const save = useCallback(
    (input: GeneralSettingsInput) => saveFn({ data: input }),
    [saveFn]
  );
  // A saved language drops the preview's ?locale=, and the root reads its catalog again, as the preview does.
  const saved = useCallback(() => {
    navigate({ replace: true, search: {} })
      .then(() => router.invalidate())
      .catch(() => undefined);
  }, [navigate, router]);
  return (
    <GeneralForm
      onPreviewLanguage={preview}
      onSaved={saved}
      save={save}
      settings={settings}
    />
  );
}
